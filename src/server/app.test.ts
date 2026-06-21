import { describe, expect, test } from "bun:test";
import type { Magazine } from "../shared/magazine.ts";
import type { Post } from "../shared/post.ts";
import type { ArticleCluster } from "./curate.ts";
import { handleRequest, type SurpriseContext } from "./app.ts";
import { type DeepDeps, newDeepCache } from "./deep.ts";
import { InFlightGuard } from "./surprise.ts";
import { startServer, HOSTNAME } from "./index.ts";

const LOCAL = "http://127.0.0.1:4321";

function build(path: string, method: string, headers: Record<string, string>): Request {
  return new Request(`${LOCAL}${path}`, { method, headers, body: method === "GET" ? undefined : "{}" });
}

const goodMutation = {
  host: "127.0.0.1:4321",
  origin: "http://127.0.0.1:4321",
  "content-type": "application/json",
};

const ARTICLE: Post = { postId: "https://p/p/a", title: "A", url: "https://p/p/a", date: null, contentHtml: "", contentText: "deep", images: [], locked: false, source: "archive" };
const CLUSTERS: ArticleCluster[] = [
  { theme: "Meaning", articles: [ARTICLE], strength: "strong" },
  { theme: "Grief", articles: [ARTICLE], strength: "strong" },
];
function magFor(title: string): Magazine {
  return { id: title, newsletter: "Deep Thoughts", newsletterUrl: "https://deep.substack.com", title, intro: "i", themes: [title], vibePresetId: "vintage-science", accentColor: "#8a3b2f", generatedAt: "2026-06-01T00:00:00.000Z", sections: [] };
}

/** A context with all deep-dive stages faked — no network, no codex, no disk. One press -> one magazine. */
function fakeContext(over: Partial<DeepDeps> = {}): SurpriseContext {
  const deps: DeepDeps = {
    newDebugId: () => "dbg-app",
    log: () => {},
    pick: async () => "deep.substack.com",
    fetch: async (domain) => ({ newsletter: "Deep Thoughts", domain, articles: [ARTICLE] }),
    curate: async () => CLUSTERS,
    synth: async (_nl, _dom, cluster) => ({ newsletter: "Deep Thoughts", domain: "deep.substack.com", title: cluster.theme, intro: "i", themes: [cluster.theme], vibePresetId: "vintage-science", accentColor: "#8a3b2f", imageQueries: [], sections: [] }),
    images: async (synth) => ({ ...synth, usedCse: false, sections: [] }),
    persist: async (plan) => ({ slug: plan.title ?? "x", dir: "/tmp/x", magazine: magFor(plan.title ?? "x") }),
    random: () => 0.99, // >= REUSE_PROB -> deterministic FRESH branch
    now: () => 0,
    ...over,
  };
  return { deps, guard: new InFlightGuard(), cache: newDeepCache(), vaultRoot: "/tmp/deep-test-no-vault" };
}

describe("POST /surprise — deep-dive pipeline", () => {
  test("presses exactly ONE deep-dive per press and returns it with a debug id", async () => {
    const res = await handleRequest(build("/surprise", "POST", goodMutation), fakeContext());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-debug-id")).toBe("dbg-app");
    const body = (await res.json()) as { publication: string; magazines: Magazine[] };
    expect(body.publication).toBe("Deep Thoughts");
    expect(body.magazines).toHaveLength(1);
    expect(["Meaning", "Grief"]).toContain(body.magazines[0]!.title);
  });

  test("a second concurrent /surprise is rejected with 409 (in-flight guard)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ctx = fakeContext({ curate: async () => { await gate; return CLUSTERS; } });

    const first = handleRequest(build("/surprise", "POST", goodMutation), ctx);
    // Let the first request acquire the guard before the second arrives.
    await Promise.resolve();
    const second = await handleRequest(build("/surprise", "POST", goodMutation), ctx);
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string; debugId: string } };
    expect(body.error.code).toBe("busy");
    expect(body.error.debugId).toBe("dbg-app"); // even a rejected request is traceable

    release();
    expect((await first).status).toBe(200);
  });

  test("releases the guard after a request so the next one succeeds", async () => {
    const ctx = fakeContext();
    expect((await handleRequest(build("/surprise", "POST", goodMutation), ctx)).status).toBe(200);
    expect((await handleRequest(build("/surprise", "POST", goodMutation), ctx)).status).toBe(200);
  });

  test("streams per-stage SSE progress, exactly ONE result, then a done event", async () => {
    const req = new Request(`${LOCAL}/surprise`, {
      method: "POST",
      headers: { ...goodMutation, accept: "text/event-stream" },
      body: "{}",
    });
    const res = await handleRequest(req, fakeContext());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    for (const stage of ["pick", "fetch", "curate", "synthesize", "images", "persist"]) {
      expect(text).toContain(`"stage":"${stage}"`);
    }
    expect((text.match(/event: result/g) ?? []).length).toBe(1); // one deep-dive per press
    expect(text).toContain("event: done");
    expect(text).toMatch(/Meaning|Grief/);
  });

  test("the empty outcome streams ZERO result events then done {magazines:0}", async () => {
    // Every fetch fails -> acquisition retries to exhaustion -> no pub found.
    const ctx = fakeContext({ fetch: async () => { throw new Error("network down"); } });
    const req = new Request(`${LOCAL}/surprise`, { method: "POST", headers: { ...goodMutation, accept: "text/event-stream" }, body: "{}" });
    const text = await (await handleRequest(req, ctx)).text();
    expect((text.match(/event: result/g) ?? []).length).toBe(0);
    expect(text).toContain("event: done");
    expect(text).toContain('"magazines":0');
    expect(text).not.toContain("event: error"); // an empty acquisition is NOT an error
  });

  test("image warnings (no ms) do NOT emit a progress event", async () => {
    const ctx = fakeContext({
      curate: async () => [CLUSTERS[0]!],
      images: async (synth, _p, warn) => { warn("images: GOOGLE_CSE_KEY not set"); return { ...synth, usedCse: false, sections: [] }; },
    });
    const req = new Request(`${LOCAL}/surprise`, { method: "POST", headers: { ...goodMutation, accept: "text/event-stream" }, body: "{}" });
    const text = await (await handleRequest(req, ctx)).text();
    expect((text.match(/"stage":"images"/g) ?? []).length).toBe(1); // single cluster -> one completion, warn excluded
  });

  test("a client disconnect frees the guard once the pipeline finishes (no wedge)", async () => {
    const ctx = fakeContext();
    const sseReq = (): Request => new Request(`${LOCAL}/surprise`, { method: "POST", headers: { ...goodMutation, accept: "text/event-stream" }, body: "{}" });
    const res = await handleRequest(sseReq(), ctx);
    await res.body!.cancel(); // client disconnects mid-stream
    await new Promise((r) => setTimeout(r, 30)); // fake pipeline finishes -> guard released
    const res2 = await handleRequest(sseReq(), ctx);
    expect(res2.status).toBe(200); // not wedged on "busy"
    await res2.body?.cancel();
  });

  test("streams an error event (not a stage) when a stage fails, and frees the guard", async () => {
    const ctx = fakeContext({ synth: async () => { throw new Error("codex exploded"); } });
    const req = (): Request => new Request(`${LOCAL}/surprise`, {
      method: "POST", headers: { ...goodMutation, accept: "text/event-stream" }, body: "{}",
    });
    const text = await (await handleRequest(req(), ctx)).text();
    expect(text).toContain("event: error");
    expect(text).toContain(`"stage":"synthesize"`);
    expect(text).not.toContain("codex exploded"); // internal detail not leaked
    // guard was released when the stream closed -> a fresh request still streams
    expect((await handleRequest(req(), ctx)).status).toBe(200);
  });

  // A PRESS-stage failure -> structured envelope: right status, the failing stage,
  // the debugId, and a FIXED public message (no leaked internals). (Acquisition-stage
  // failures — pick/fetch/curate — are retried, not surfaced; covered separately below.)
  const stageFailures = [
    { stage: "synthesize", make: (): Partial<DeepDeps> => ({ synth: async () => { throw new Error("secret /Users/x path"); } }), status: 502 },
    { stage: "images", make: (): Partial<DeepDeps> => ({ images: async () => { throw new Error("secret /Users/x path"); } }), status: 500 },
    { stage: "persist", make: (): Partial<DeepDeps> => ({ persist: async () => { throw new Error("secret /Users/x path"); } }), status: 500 },
  ] as const;

  for (const { stage, make, status } of stageFailures) {
    test(`a ${stage}-stage failure -> ${status} envelope with debugId and no leaked detail`, async () => {
      const res = await handleRequest(build("/surprise", "POST", goodMutation), fakeContext(make()));
      expect(res.status).toBe(status);
      const body = (await res.json()) as { error: { debugId: string; stage: string; code: string; message: string } };
      expect(body.error.stage).toBe(stage);
      expect(body.error.code).toBe(stage);
      expect(body.error.debugId).toBe("dbg-app");
      expect(body.error.message).not.toContain("secret"); // internal cause is NOT leaked
      expect(body.error.message.length).toBeGreaterThan(0);
    });
  }

  test("a persistent acquisition failure (every pick/fetch fails) is retried then returns an empty 200, not an error", async () => {
    const res = await handleRequest(build("/surprise", "POST", goodMutation), fakeContext({ fetch: async () => { throw new Error("network down"); } }));
    expect(res.status).toBe(200); // not surfaced as an error — acquisition is best-effort/retried
    const body = (await res.json()) as { publication: string; magazines: Magazine[] };
    expect(body.magazines).toEqual([]); // no usable pub found within the attempt bound
  });

  test("the in-flight guard is released after a FAILED (press-stage) request (next one succeeds)", async () => {
    const ctx = fakeContext({ persist: async () => { throw new Error("boom"); } });
    expect((await handleRequest(build("/surprise", "POST", goodMutation), ctx)).status).toBe(500);
    // Guard freed in the finally block -> a fresh, healthy request is admitted.
    ctx.deps.persist = async (plan) => ({ slug: plan.title ?? "x", dir: "/tmp/x", magazine: magFor(plan.title ?? "x") });
    expect((await handleRequest(build("/surprise", "POST", goodMutation), ctx)).status).toBe(200);
  });
});

describe("handleRequest — hostile Host rejected on all routes (rebinding)", () => {
  const hostileHost = { ...goodMutation, host: "attacker.example.com" };
  for (const [path, method] of [
    ["/surprise", "POST"],
    ["/api/library/abc", "DELETE"],
    ["/library-assets/abc/img.png", "GET"],
  ] as const) {
    test(`${method} ${path}`, async () => {
      const res = await handleRequest(build(path, method, hostileHost), fakeContext());
      expect(res.status).toBe(403);
    });
  }
});

describe("handleRequest — hostile Origin rejected on mutations (CSRF)", () => {
  for (const [path, method] of [
    ["/surprise", "POST"],
    ["/api/library/abc", "DELETE"],
  ] as const) {
    test(`${method} ${path}`, async () => {
      const res = await handleRequest(
        build(path, method, { ...goodMutation, origin: "https://evil.example.com" }),
        fakeContext(),
      );
      expect(res.status).toBe(403);
    });
  }
});

describe("handleRequest — cross-origin asset read rejected", () => {
  test("GET /library-assets with a hostile Origin is 403", async () => {
    const res = await handleRequest(
      build("/library-assets/x/img.png", "GET", {
        host: "127.0.0.1:4321",
        origin: "https://evil.example.com",
      }),
      fakeContext(),
    );
    expect(res.status).toBe(403);
  });
});

describe("server binding", () => {
  test("binds to loopback only and serves over 127.0.0.1", async () => {
    expect(HOSTNAME).toBe("127.0.0.1");
    const server = startServer(0, fakeContext()); // ephemeral port + faked pipeline
    try {
      // Bun normalizes the bound hostname; loopback bind => unreachable off-host.
      expect(server.hostname).toBe("127.0.0.1");
      const res = await fetch(`http://127.0.0.1:${server.port}/surprise`, {
        method: "POST",
        headers: { origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("rejects a forged non-local Host header over the real socket", async () => {
    const server = startServer(0, fakeContext());
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/surprise`, {
        method: "POST",
        headers: {
          host: "attacker.example.com",
          origin: "http://127.0.0.1",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(res.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });
});
