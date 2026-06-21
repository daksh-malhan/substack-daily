/**
 * Assembly endpoint orchestration (PLAN.md MG7). Chains the MG2–MG6 pipeline
 * behind `POST /surprise`:
 *
 *   pick (LastPickStore) -> fetchPublication -> synthesize (codex)
 *     -> acquireImages -> persistMagazine (auto-save vault) -> Magazine
 *
 * Each stage is injectable (see `SurpriseDeps`) so the whole flow is testable
 * offline with a fake fetch + a fake codex runner — no network, no real codex.
 * Cross-cutting concerns live here, not in the HTTP layer:
 *   - a per-request `debugId` threaded through structured per-stage logs
 *     (timings + domain/post/image counts) for observability;
 *   - a `StageError` that names the failing stage and carries the `debugId`, so
 *     the router can emit a structured error envelope instead of a 500 dump;
 *   - an `InFlightGuard` so a second `/surprise` while one runs is rejected,
 *     never racing the shared pool/last-pick/vault state.
 */
import { randomUUID } from "node:crypto";
import type { Magazine } from "../shared/magazine.ts";
import type { FetchResult, Post } from "../shared/post.ts";
import { acquireImages, type ImagePlan } from "./images.ts";
import { LastPickStore, loadPool } from "./pool.ts";
import { fetchPublication } from "./fetcher.ts";
import { synthesize, type CodexRunner, type SynthesisResult } from "./synth.ts";
import { persistMagazine } from "./vault.ts";

export type Stage = "pick" | "fetch" | "curate" | "synthesize" | "images" | "persist";

/** One structured log line. `stage` is a pipeline stage or a lifecycle marker. */
export interface LogEntry {
  debugId: string;
  stage: Stage | "start" | "done";
  ms?: number;
  error?: string;
  [key: string]: unknown;
}

/** A failed pipeline stage, tagged with the stage name + request debugId. */
export class StageError extends Error {
  readonly stage: Stage;
  readonly cause: unknown;
  debugId?: string;
  constructor(stage: Stage, cause: unknown) {
    super(`stage ${stage} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StageError";
    this.stage = stage;
    this.cause = cause;
  }
}

/** Injectable, pre-bound pipeline stages. `makeSurpriseDeps` wires the real ones. */
export interface SurpriseDeps {
  newDebugId: () => string;
  log: (entry: LogEntry) => void;
  pick: () => Promise<string>;
  fetch: (domain: string) => Promise<FetchResult>;
  synth: (fetched: FetchResult) => Promise<SynthesisResult>;
  /** `warn` is supplied per-request so image warnings correlate with the debugId. */
  images: (synth: SynthesisResult, posts: Post[], warn: (msg: string) => void) => Promise<ImagePlan>;
  persist: (plan: ImagePlan) => Promise<{ slug: string; dir: string; magazine: Magazine }>;
}

export interface SurpriseResult {
  debugId: string;
  magazine: Magazine;
  slug: string;
  dir: string;
}

async function timed<T>(
  stage: Stage,
  log: (e: LogEntry) => void,
  debugId: string,
  run: () => Promise<T>,
  summarize: (out: T) => Record<string, unknown>,
): Promise<T> {
  const start = Date.now();
  try {
    const out = await run();
    log({ debugId, stage, ms: Date.now() - start, ...summarize(out) });
    return out;
  } catch (error) {
    log({ debugId, stage, ms: Date.now() - start, error: error instanceof Error ? error.message : String(error) });
    throw new StageError(stage, error);
  }
}

const countExcerpts = (s: SynthesisResult): number =>
  s.sections.reduce((n, sec) => n + sec.excerpts.length, 0);

/**
 * Run the full pick→persist pipeline once. Throws `StageError` (with debugId).
 * The caller may pass a `debugId` so one id spans the whole request lifecycle
 * (e.g. the busy-rejection path); otherwise a fresh one is minted.
 */
export async function runSurprise(deps: SurpriseDeps, debugId: string = deps.newDebugId()): Promise<SurpriseResult> {
  const overall = Date.now();
  deps.log({ debugId, stage: "start" });

  try {
    const domain = await timed("pick", deps.log, debugId, () => deps.pick(), (d) => ({ domain: d }));
    const fetched = await timed("fetch", deps.log, debugId, () => deps.fetch(domain), (f) => ({
      domain: f.domain,
      newsletter: f.newsletter,
      posts: f.posts.length,
      archiveOk: f.archiveOk,
    }));
    const synth = await timed("synthesize", deps.log, debugId, () => deps.synth(fetched), (s) => ({
      sections: s.sections.length,
      excerpts: countExcerpts(s),
      vibe: s.vibePresetId,
      themes: s.themes.length,
      imageQueries: s.imageQueries.length,
    }));
    const plan = await timed("images", deps.log, debugId, () => deps.images(synth, fetched.posts, (msg) => deps.log({ debugId, stage: "images", warn: msg })), (p) => ({
      usedCse: p.usedCse,
      withImage: p.sections.filter((sec) => sec.image.kind === "image").length,
      typographic: p.sections.filter((sec) => sec.image.kind === "typographic").length,
    }));
    const saved = await timed("persist", deps.log, debugId, () => deps.persist(plan), (r) => ({
      slug: r.slug,
      dir: r.dir,
      imagesSaved: r.magazine.sections.reduce((n, sec) => n + sec.images.length, 0),
    }));

    deps.log({ debugId, stage: "done", ms: Date.now() - overall, slug: saved.slug });
    return { debugId, magazine: saved.magazine, slug: saved.slug, dir: saved.dir };
  } catch (error) {
    const stageError = error instanceof StageError ? error : new StageError("pick", error);
    stageError.debugId = debugId;
    throw stageError;
  }
}

// ---- Real wiring -----------------------------------------------------------

export interface SurpriseConfig {
  poolPath: string;
  /** `.state/last-pick.json` — the locked last-pick store path. */
  statePath: string;
  /** `./library` — the Obsidian vault / offline data store. */
  vaultRoot: string;
  fetchImpl?: typeof fetch;
  runner?: CodexRunner;
  googleKey?: string;
  googleCseId?: string;
  /** ISO timestamp source for persisted magazines (defaults to wall clock). */
  now?: () => string;
  log?: (entry: LogEntry) => void;
}

function defaultLog(entry: LogEntry): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));
}

/** Bind the real MG2–MG6 stages to a config. The server uses this; tests don't. */
export function makeSurpriseDeps(cfg: SurpriseConfig): SurpriseDeps {
  const store = new LastPickStore(cfg.statePath);
  const log = cfg.log ?? defaultLog;
  return {
    newDebugId: () => randomUUID().slice(0, 8),
    log,
    pick: async () => store.pick(await loadPool(cfg.poolPath)),
    fetch: (domain) => fetchPublication(domain, { fetchImpl: cfg.fetchImpl }),
    synth: (fetched) => synthesize(fetched, cfg.runner ? { runner: cfg.runner } : {}),
    images: (synth, posts, warn) =>
      acquireImages(synth, posts, {
        googleKey: cfg.googleKey,
        googleCseId: cfg.googleCseId,
        fetchImpl: cfg.fetchImpl,
        warn,
      }),
    persist: (plan) =>
      persistMagazine(plan, {
        vaultRoot: cfg.vaultRoot,
        fetchImpl: cfg.fetchImpl,
        now: cfg.now?.(),
      }),
  };
}

// ---- Concurrency guard -----------------------------------------------------

/**
 * Single-slot in-flight guard. The pipeline mutates shared state (last-pick,
 * pool, vault), so we run at most one `/surprise` at a time; a concurrent
 * request is rejected (HTTP 409) rather than queued, keeping the UX honest.
 */
export class InFlightGuard {
  private busy = false;
  tryAcquire(): boolean {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }
  release(): void {
    this.busy = false;
  }
}
