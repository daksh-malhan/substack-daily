/**
 * Request router for the local app (PLAN.md MG1 + MG7).
 *
 * `handleRequest` is a pure `(Request, ctx) -> Response` function (no socket), so
 * the security middleware and routes can be unit-tested directly, and the whole
 * `/surprise` pipeline can be driven with a fake context (injected stages). The
 * real context (`createDefaultContext`) wires MG2–MG6; `index.ts` binds it to
 * 127.0.0.1 with Bun.serve.
 *
 * Routes:
 *   POST   /surprise              -> run the pipeline, auto-save, return the Magazine
 *   GET    /api/library           -> list saved (complete) magazines           (asset guard)
 *   GET    /api/library/:id       -> a saved magazine's JSON for offline render (asset guard)
 *   DELETE /api/library/:id       -> delete a saved magazine by validated id    (mutating guard)
 *   GET    /library-assets/:id/*  -> serve a saved magazine's local images      (asset guard)
 *   GET    *                      -> static frontend from dist/web
 */
import { resolve } from "node:path";
import { resolveInVault } from "../shared/paths.ts";
import { isMutatingMethod, type RouteKind, securityCheck } from "./security.ts";
import { deleteEntry, listLibrary, readMagazine, resolveAsset } from "./library.ts";
import { type DeepCache, type DeepDeps, makeDeepDeps, newDeepCache, runDeepDive } from "./deep.ts";
import { InFlightGuard, StageError, type Stage, type SurpriseConfig } from "./surprise.ts";

const WEB_DIR = resolve(import.meta.dir, "../../dist/web");
const REPO_ROOT = resolve(import.meta.dir, "../..");

/** Everything the router needs. Injected in tests. */
export interface SurpriseContext {
  deps: DeepDeps;
  guard: InFlightGuard;
  /** Per-session deep-dive cache: fetched/curated pubs + pressed themes, reused across presses. */
  cache: DeepCache;
  /** The Obsidian vault / offline data store the Library reads. */
  vaultRoot: string;
}

/** Build the real context from env (used by the server, never by unit tests). */
export function createDefaultContext(overrides: Partial<SurpriseConfig> = {}): SurpriseContext {
  const config: SurpriseConfig = {
    poolPath: resolve(REPO_ROOT, "config/pool.json"),
    statePath: resolve(REPO_ROOT, ".state/last-pick.json"),
    // VAULT_ROOT lets you point the app at an alternate vault (portable copy / test).
    vaultRoot: process.env.VAULT_ROOT ? resolve(process.env.VAULT_ROOT) : resolve(REPO_ROOT, "library"),
    googleKey: process.env.GOOGLE_CSE_KEY,
    googleCseId: process.env.GOOGLE_CSE_ID,
    ...overrides,
  };
  return { deps: makeDeepDeps(config), guard: new InFlightGuard(), cache: newDeepCache(), vaultRoot: config.vaultRoot };
}

let defaultContext: SurpriseContext | null = null;
function getDefaultContext(): SurpriseContext {
  return (defaultContext ??= createDefaultContext());
}

function classifyRoute(method: string, pathname: string): RouteKind {
  if (pathname.startsWith("/library-assets/")) return "asset";
  // Library JSON reads expose local vault data -> block cross-origin like assets;
  // DELETE is a mutation -> exact same-origin JSON.
  if (pathname === "/api/library" || pathname.startsWith("/api/library/")) {
    return isMutatingMethod(method) ? "mutating" : "asset";
  }
  if (pathname === "/surprise" && method === "POST") return "mutating";
  return "static";
}

// Fixed, public-facing messages per stage. The detailed cause (which may carry
// filesystem paths or codex diagnostics) is recorded in the structured logs only,
// never returned to the client — the envelope stays a clean, non-leaking summary.
const STAGE_MESSAGE: Record<Stage, string> = {
  pick: "couldn't choose a newsletter",
  fetch: "couldn't read the publication's archive",
  curate: "couldn't sort the articles",
  synthesize: "couldn't compose a deep-dive",
  images: "couldn't prepare images",
  persist: "couldn't save a deep-dive",
};

interface ErrorEnvelope {
  error: { debugId: string; stage: Stage | null; code: string; message: string };
}

/** Map a pipeline failure to a status + a structured (no-stack) envelope body. */
function surpriseErrorInfo(error: unknown, debugId: string): { status: number; body: ErrorEnvelope } {
  if (error instanceof StageError) {
    // fetch/synth depend on external services (Substack, codex) -> 502; the rest
    // are internal -> 500. The envelope carries the debugId for log correlation.
    const upstream: Stage[] = ["fetch", "synthesize"];
    return {
      status: upstream.includes(error.stage) ? 502 : 500,
      body: { error: { debugId: error.debugId ?? debugId, stage: error.stage, code: error.stage, message: STAGE_MESSAGE[error.stage] } },
    };
  }
  return { status: 500, body: { error: { debugId, stage: null, code: "internal", message: "internal error" } } };
}

function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Stream the pipeline as Server-Sent Events when the client asks for them
 * (`Accept: text/event-stream`), so the UI shows REAL per-stage progress during
 * the 30s–2min build. Each completed stage the pipeline logs becomes a `stage`
 * event; the run ends with a `result` (the Magazine) or `error` event. The guard
 * is held for the life of the stream and released when it closes.
 */
function streamSurprise(ctx: SurpriseContext, debugId: string): Response {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false; // set on client cancel OR normal close

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Every enqueue is guarded: after the client disconnects (cancel) a late
      // heartbeat or stage frame must NO-OP, never throw — a throw out of the
      // tee'd log would otherwise abort the pipeline mid-stage.
      const send = (frame: Uint8Array): void => {
        if (closed) return;
        try {
          controller.enqueue(frame);
        } catch {
          closed = true;
        }
      };
      // Heartbeat: an SSE comment every 5s so a long, silent stage (synthesis)
      // never lets the connection go idle.
      heartbeat = setInterval(() => send(new TextEncoder().encode(": keepalive\n\n")), 5000);

      // Tee the pipeline's per-stage logs into `stage` events. ONLY completed
      // stages carry `ms`; image warnings reuse stage:"images" without `ms` and
      // must not falsely advance the UI.
      const deps: DeepDeps = {
        ...ctx.deps,
        log: (entry) => {
          ctx.deps.log(entry);
          if (typeof entry.ms === "number" && entry.stage !== "start" && entry.stage !== "done" && !entry.error) {
            send(sseFrame("stage", { stage: entry.stage, ms: entry.ms, theme: entry.theme }));
          }
        },
        onMagazine: (magazine) => send(sseFrame("result", magazine)), // stream each deep-dive as it finishes
      };
      try {
        const result = await runDeepDive(deps, ctx.cache, debugId);
        send(sseFrame("done", { publication: result.publication, magazines: result.magazines.length }));
      } catch (error) {
        send(sseFrame("error", surpriseErrorInfo(error, debugId).body));
      } finally {
        // The guard is released ONLY when the pipeline truly finishes — even on a
        // client disconnect — so an abandoned in-flight build can't race a new
        // one over the shared pool/vault. (The codex runner has a hard timeout,
        // so this can never hold the guard forever.)
        clearInterval(heartbeat);
        ctx.guard.release();
        if (!closed) {
          try {
            controller.close();
          } catch {
            // already closed (cancelled) — ignore
          }
        }
      }
    },
    cancel() {
      // Client disconnected mid-stream: stop the heartbeat and silence further
      // sends. The pipeline keeps running to completion in the background, where
      // `start`'s finally releases the guard.
      closed = true;
      clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-debug-id": debugId },
  });
}

/** Minimal slice of Bun.Server we use: extend a single request's idle timeout. */
interface RequestTimeoutCapable {
  timeout(req: Request, seconds: number): void;
}

async function handleSurprise(
  req: Request,
  ctx: SurpriseContext,
  server?: RequestTimeoutCapable,
): Promise<Response> {
  // Mint the debugId BEFORE acquiring the guard so every response — including a
  // busy rejection — is traceable to a single id spanning the whole request.
  const debugId = ctx.deps.newDebugId();
  if (!ctx.guard.tryAcquire()) {
    ctx.deps.log({ debugId, stage: "start", rejected: "busy" });
    return Response.json(
      { error: { debugId, stage: null, code: "busy", message: "a magazine is already being generated" } },
      { status: 409 },
    );
  }

  // Only THIS request gets a long idle timeout (the build is 30s–2min); other
  // routes keep Bun's short default, so a stalled static/library request can't
  // hold a connection open for minutes.
  server?.timeout(req, 250);

  if ((req.headers.get("accept") ?? "").includes("text/event-stream")) {
    return streamSurprise(ctx, debugId); // guard released when the stream closes
  }

  try {
    const result = await runDeepDive(ctx.deps, ctx.cache, debugId);
    return Response.json({ publication: result.publication, magazines: result.magazines }, { headers: { "x-debug-id": debugId } });
  } catch (error) {
    const { status, body } = surpriseErrorInfo(error, debugId);
    return Response.json(body, { status });
  } finally {
    ctx.guard.release();
  }
}

/** Percent-decode a single path segment; null if malformed. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

async function handleLibraryRoute(req: Request, ctx: SurpriseContext, pathname: string): Promise<Response> {
  const { method } = req;

  if (pathname === "/api/library" && (method === "GET" || method === "HEAD")) {
    return Response.json(await listLibrary(ctx.vaultRoot));
  }

  if (pathname.startsWith("/api/library/")) {
    const id = decodeSegment(pathname.slice("/api/library/".length));
    if (id === null) return Response.json({ error: "bad request" }, { status: 400 });

    if (method === "GET" || method === "HEAD") {
      const magazine = await readMagazine(ctx.vaultRoot, id);
      if (!magazine) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(magazine);
    }
    if (method === "DELETE") {
      const result = await deleteEntry(ctx.vaultRoot, id);
      if (result === "invalid") return Response.json({ error: "invalid entry id" }, { status: 400 });
      if (result === "not-found") return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ deleted: id });
    }
    return new Response("method not allowed", { status: 405 });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

async function handleAsset(req: Request, ctx: SurpriseContext, pathname: string): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });

  const rest = pathname.slice("/library-assets/".length);
  const slash = rest.indexOf("/");
  if (slash === -1) return Response.json({ error: "not found" }, { status: 404 });

  const entryId = decodeSegment(rest.slice(0, slash));
  const relSegments = rest.slice(slash + 1).split("/").map(decodeSegment);
  if (entryId === null || relSegments.some((s) => s === null)) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const relPath = (relSegments as string[]).join("/");

  const asset = await resolveAsset(ctx.vaultRoot, entryId, relPath);
  if (!asset) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(Bun.file(asset.absPath), { headers: { "content-type": asset.contentType } });
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let filePath: string;
  try {
    // Containment guard: never serve outside dist/web even with ../ in the path.
    filePath = resolveInVault(WEB_DIR, rel);
  } catch {
    return new Response("forbidden", { status: 403 });
  }
  const file = Bun.file(filePath);
  if (await file.exists()) return new Response(file);

  // SPA fallback to index.html (so the frontend route still loads).
  const index = Bun.file(resolve(WEB_DIR, "index.html"));
  if (await index.exists()) return new Response(index);

  return new Response(
    "Frontend not built yet — run `bun run build:web` (or `bun run dev`).",
    { status: 404, headers: { "content-type": "text/plain" } },
  );
}

export async function handleRequest(
  req: Request,
  ctx: SurpriseContext = getDefaultContext(),
  server?: RequestTimeoutCapable,
): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const { method } = req;

  const rejection = securityCheck(req, classifyRoute(method, pathname));
  if (rejection) return rejection;

  if (pathname === "/surprise" && method === "POST") {
    return handleSurprise(req, ctx, server);
  }

  // Library + asset I/O can throw (fs errors, reconcile failures); convert any
  // escape into a fixed, non-leaking JSON 500 rather than a stack dump.
  if (pathname === "/api/library" || pathname.startsWith("/api/library/")) {
    try {
      return await handleLibraryRoute(req, ctx, pathname);
    } catch {
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  }

  if (pathname.startsWith("/library-assets/")) {
    try {
      return await handleAsset(req, ctx, pathname);
    } catch {
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  }

  if (method === "GET" || method === "HEAD") {
    return serveStatic(pathname);
  }

  return new Response("method not allowed", { status: 405 });
}
