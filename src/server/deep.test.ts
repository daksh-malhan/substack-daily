import { describe, expect, test } from "bun:test";
import type { Magazine } from "../shared/magazine.ts";
import type { Post } from "../shared/post.ts";
import type { ArticleCluster } from "./curate.ts";
import type { ImagePlan } from "./images.ts";
import type { SynthesisResult } from "./synth.ts";
import { type DeepCache, type DeepDeps, mergeDeepArticles, newDeepCache, runDeepDive } from "./deep.ts";
import { budgetPosts } from "./synth.ts";
import { type LogEntry, StageError } from "./surprise.ts";

function post(id: string): Post {
  return { postId: id, title: `Article ${id}`, url: `https://p.com/p/${id}`, date: null, contentHtml: "", contentText: `deep text ${id}`, images: [], locked: false, source: "archive" };
}
const [A, B, C] = [post("a"), post("b"), post("c")];

const CLUSTERS: ArticleCluster[] = [
  { theme: "The texture of meaning", articles: [A, B], strength: "strong" },
  { theme: "The shape of grief", articles: [C], strength: "strong" },
  { theme: "Shallow AI takes", articles: [], strength: "weak" },
];

function synthFor(theme: string): SynthesisResult {
  return { newsletter: "Deep Thoughts", domain: "p.com", title: theme, intro: "i", themes: [theme], vibePresetId: "classic-editorial", accentColor: "#8a3b2f", imageQueries: [], sections: [{ heading: "h", prose: "p", excerpts: [{ text: "t", sourceUrl: "https://p.com/p/a", sourceTitle: "A", postId: "https://p.com/p/a" }] }] };
}
function magFor(title: string): Magazine {
  return { id: title, newsletter: "Deep Thoughts", newsletterUrl: "https://p.com", title, intro: "i", themes: [title], vibePresetId: "classic-editorial", accentColor: "#8a3b2f", generatedAt: "2026-06-20T00:00:00.000Z", sections: [] };
}

interface Calls { pick: number; fetch: number; curate: number }
function fakeDeps(over: Partial<DeepDeps> = {}): { deps: DeepDeps; logs: LogEntry[]; emitted: Magazine[]; calls: Calls } {
  const logs: LogEntry[] = [];
  const emitted: Magazine[] = [];
  const calls: Calls = { pick: 0, fetch: 0, curate: 0 };
  const deps: DeepDeps = {
    newDebugId: () => "dbg-deep",
    log: (e) => logs.push(e),
    pick: async () => { calls.pick++; return "p.com"; },
    fetch: async (domain) => { calls.fetch++; return { newsletter: "Deep Thoughts", domain, articles: [A, B, C] }; },
    curate: async () => { calls.curate++; return CLUSTERS; },
    synth: async (_nl, _dom, cluster) => synthFor(cluster.theme),
    images: async (synth) => ({ ...synth, usedCse: false, sections: [{ heading: "h", prose: "p", excerpts: [], image: { kind: "typographic" } }] }) as ImagePlan,
    persist: async (plan) => ({ slug: plan.title ?? "x", dir: `/tmp/${plan.title}`, magazine: magFor(plan.title ?? "x") }),
    random: () => 0.99, // default: >= REUSE_PROB -> fresh branch
    now: () => 0,
    onMagazine: (m) => emitted.push(m),
    ...over,
  };
  return { deps, logs, emitted, calls };
}

const STRONG_THEMES = ["The texture of meaning", "The shape of grief"];
// Cache only ever holds strongClusters() output, so pre-seeds must mirror that invariant.
const STRONG = CLUSTERS.filter((c) => c.strength === "strong");

describe("runDeepDive (one deep-dive per press)", () => {
  test("a single press presses EXACTLY ONE magazine and emits it once", async () => {
    const { deps, emitted } = fakeDeps();
    const res = await runDeepDive(deps, newDeepCache());
    expect(res.magazines).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.title).toBe(res.magazines[0]!.title);
    expect(res.publication).toBe("Deep Thoughts");
    expect(res.debugId).toBe("dbg-deep");
    expect(STRONG_THEMES).toContain(res.magazines[0]!.title); // a strong cluster, weak/empty excluded
  });

  test("the next press REUSES a cached pub (random<0.3) without re-pick/fetch/curate", async () => {
    const { deps, calls } = fakeDeps({ random: () => 0 });
    const cache = newDeepCache();
    await runDeepDive(deps, cache); // press 1: empty cache -> fresh
    const after1: Calls = { ...calls };
    const res2 = await runDeepDive(deps, cache); // press 2: reusable + random 0 < 0.3 -> reuse
    expect(calls.pick).toBe(after1.pick); // not re-invoked
    expect(calls.fetch).toBe(after1.fetch);
    expect(calls.curate).toBe(after1.curate);
    expect(res2.magazines).toHaveLength(1);
  });

  test("random>=0.3 takes the FRESH branch even when a reusable pub exists", async () => {
    const { deps, calls } = fakeDeps({ random: () => 0.99 });
    const cache: DeepCache = newDeepCache();
    cache.pubs.set("old.com", { newsletter: "Old", clusters: STRONG });
    await runDeepDive(deps, cache);
    expect(calls.fetch).toBeGreaterThan(0); // a fresh fetch happened
    expect(cache.pubs.has("p.com")).toBe(true); // new pub cached under its resolved domain
  });

  test("never presses the same (domain, theme) twice; exhausting the pub yields an empty result", async () => {
    const { deps, emitted } = fakeDeps({ random: () => 0 });
    const cache = newDeepCache();
    const t1 = (await runDeepDive(deps, cache)).magazines[0]!.title;
    const t2 = (await runDeepDive(deps, cache)).magazines[0]!.title;
    expect(new Set([t1, t2]).size).toBe(2); // two distinct themes
    const res3 = await runDeepDive(deps, cache); // both pressed -> pool re-picks p.com (excluded) -> empty
    expect(res3.magazines).toEqual([]);
    expect(emitted).toHaveLength(2); // no emit on the empty outcome
  });

  test("retries past a pub that curates to ZERO strong clusters (bounded)", async () => {
    let n = 0;
    const { deps, calls } = fakeDeps({
      random: () => 0.99,
      pick: async (exclude) => { calls.pick++; return ["weak.com", "good.com"].find((d) => !exclude?.has(d)) ?? "good.com"; },
      curate: async () => { calls.curate++; return n++ === 0 ? [{ theme: "shallow", articles: [A], strength: "weak" }] : CLUSTERS; },
    });
    const res = await runDeepDive(deps, newDeepCache());
    expect(res.magazines).toHaveLength(1);
    expect(STRONG_THEMES).toContain(res.magazines[0]!.title);
    expect(calls.curate).toBe(2); // first pub empty -> retried the second
  });

  test("a fresh pick that comes up empty FALLS BACK to a reusable cached cluster", async () => {
    const { deps } = fakeDeps({
      random: () => 0.99, // fresh branch
      pick: async () => "new.com",
      fetch: async (d) => ({ newsletter: "New", domain: d, articles: [A] }),
      curate: async () => [{ theme: "shallow", articles: [A], strength: "weak" }], // fresh never yields strong
    });
    const cache: DeepCache = newDeepCache();
    cache.pubs.set("old.com", { newsletter: "Old", clusters: STRONG });
    const res = await runDeepDive(deps, cache);
    expect(res.magazines).toHaveLength(1);
    expect(STRONG_THEMES).toContain(res.magazines[0]!.title); // came from the reusable old.com
  });

  test("a redirect alias resolving to an already-cached domain does NOT re-curate or overwrite", async () => {
    const { deps, calls } = fakeDeps({
      random: () => 0.99,
      pick: async () => "alias.substack.com",
      fetch: async () => { calls.fetch++; return { newsletter: "Real", domain: "real.com", articles: [A, B, C] }; },
    });
    const cache: DeepCache = newDeepCache();
    cache.pubs.set("real.com", { newsletter: "Real", clusters: STRONG });
    const res = await runDeepDive(deps, cache);
    expect(res.magazines).toHaveLength(1);
    expect(calls.fetch).toBe(1); // the fetch IS expected (it reveals the resolved domain)...
    expect(calls.curate).toBe(0); // ...but no re-curation on the resolved-domain collision
    expect([...cache.pubs.keys()]).toEqual(["real.com"]); // alias not added; cache identity preserved
  });

  test("the acquisition-start deadline stops new attempts (injected clock)", async () => {
    let t = 0;
    const { deps, calls } = fakeDeps({ random: () => 0.99, now: () => { const v = t; t = 1e12; return v; } });
    const res = await runDeepDive(deps, newDeepCache());
    expect(res.magazines).toEqual([]); // deadline tripped before any pick
    expect(calls.pick).toBe(0);
  });

  test("a press-stage failure surfaces as a StageError carrying the debugId and emits NOTHING", async () => {
    const { deps, emitted } = fakeDeps({ persist: async () => { throw new Error("disk full"); } });
    try {
      await runDeepDive(deps, newDeepCache());
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(StageError);
      expect((e as StageError).stage).toBe("persist");
      expect((e as StageError).debugId).toBe("dbg-deep");
    }
    expect(emitted).toEqual([]); // onMagazine never fires on the error path
  });

  test("acquisition is bounded: when every distinct pick fails, exactly 4 attempts are spent then empty", async () => {
    let i = 0;
    const { deps, calls } = fakeDeps({
      random: () => 0.99,
      pick: async () => { calls.pick++; return `pub${i++}.com`; }, // a NEW domain each time -> never excluded early
      fetch: async () => { throw new Error("network down"); }, // every fetch fails
    });
    const res = await runDeepDive(deps, newDeepCache());
    expect(res.magazines).toEqual([]);
    expect(calls.pick).toBe(4); // MAX_PICK_ATTEMPTS
  });

  test("a thrown pick and a thrown curate are each retried (not surfaced)", async () => {
    let pn = 0;
    let cn = 0;
    const { deps } = fakeDeps({
      random: () => 0.99,
      pick: async () => { pn++; if (pn === 1) throw new Error("pick boom"); return `pub${pn}.com`; },
      curate: async () => { cn++; if (cn === 1) throw new Error("curate boom"); return CLUSTERS; },
    });
    const res = await runDeepDive(deps, newDeepCache()); // attempt1 pick throws, attempt2 curate throws, attempt3 ok
    expect(res.magazines).toHaveLength(1);
    expect(STRONG_THEMES).toContain(res.magazines[0]!.title);
  });

  test("an alias resolving to a FULLY-PRESSED cached pub spends an attempt logged 'exhausted', then terminates", async () => {
    const { deps, logs, calls } = fakeDeps({
      random: () => 0.99,
      pick: async () => "alias.substack.com",
      fetch: async () => { calls.fetch++; return { newsletter: "Real", domain: "real.com", articles: [A, B, C] }; },
    });
    const cache: DeepCache = newDeepCache();
    cache.pubs.set("real.com", { newsletter: "Real", clusters: STRONG });
    for (const c of STRONG) cache.pressed.add(`real.com::${c.theme}`); // every theme already shown
    const res = await runDeepDive(deps, cache);
    expect(res.magazines).toEqual([]); // cached pub exhausted + nothing fresh -> empty (no infinite loop)
    expect(calls.curate).toBe(0); // resolved to a cached pub -> never re-curated
    expect(logs.some((l) => l.stage === "curate" && l.reason === "exhausted")).toBe(true); // (iii) classification
  });

  test("a redirect collision reuses the SAME cached entry object (no overwrite)", async () => {
    const { deps } = fakeDeps({ random: () => 0.99, pick: async () => "alias.substack.com", fetch: async () => ({ newsletter: "Real", domain: "real.com", articles: [A, B, C] }) });
    const cache: DeepCache = newDeepCache();
    cache.pubs.set("real.com", { newsletter: "Real", clusters: STRONG });
    const before = cache.pubs.get("real.com");
    await runDeepDive(deps, cache);
    expect(cache.pubs.get("real.com")).toBe(before); // identity preserved, not replaced
  });
});

const stub = (url: string): Post => ({ postId: url, title: "old", url, date: null, contentHtml: "", contentText: "", images: [], locked: false, source: "archive" });
const full = (url: string, text: string): Post => ({ postId: url, title: "t", url, date: null, contentHtml: "", contentText: text, images: [], locked: false, source: "archive" });

describe("mergeDeepArticles", () => {
  test("a body-less archive STUB never shadows the same URL's full archive body", () => {
    const url = "https://p.com/p/deep1";
    const merged = mergeDeepArticles([stub(url)], [full(url, "the full deep essay")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.contentText).toBe("the full deep essay"); // full body wins, not the empty stub
  });

  test("drops paywalled teasers and de-dupes, keeping the first full post per url", () => {
    const a = full("https://p.com/p/a", "first");
    const dupe = full("https://p.com/p/a", "second");
    const locked = { ...full("https://p.com/p/b", "teaser"), locked: true };
    const merged = mergeDeepArticles([a], [dupe, locked]);
    expect(merged.map((m) => m.url)).toEqual(["https://p.com/p/a"]);
    expect(merged[0]!.contentText).toBe("first");
  });
});

describe("deep synth budget", () => {
  test("a cluster larger than the default archive cap still admits EVERY article to the prompt", () => {
    // All cluster articles are source:"archive"; the default maxArchive (8) would
    // silently drop the 9th+, so they could never be cited. The deep flow overrides
    // it to the cluster size — assert that override admits all of them.
    const big = Array.from({ length: 12 }, (_, i) => post(`a${i}`));
    const budgeted = budgetPosts(big, { maxArchive: big.length, maxPosts: big.length });
    expect(budgeted).toHaveLength(12);
    expect(budgeted.map((p) => p.postId).toSorted()).toEqual(big.map((p) => p.postId).toSorted());
  });
});
