/**
 * Deep-dive brainfood orchestration (MG13 phase 5). Replaces the single-magazine
 * flow: one Surprise now scans a publication's archive, curates the deep articles
 * into thematic clusters, and presses a deep-dive magazine for EVERY strong
 * cluster (citing every article in the cluster).
 *
 *   pick (brainfood pool) -> deepFetch (RSS full posts + ~50 archive articles)
 *     -> curate (drop shallow/tech-AI, cluster the deep survivors)
 *     -> for each STRONG cluster: synthesize(theme) -> acquireImages -> persist
 *
 * Stages are injectable (DeepDeps) so the whole flow is offline-testable with a
 * fake codex runner + injected fetch. Reuses surprise.ts's StageError / log
 * shape; emits each finished magazine via `onMagazine` (for SSE streaming).
 */
import { randomUUID } from "node:crypto";
import type { Magazine } from "../shared/magazine.ts";
import type { Post } from "../shared/post.ts";
import { fetchDeepArticles } from "./archive-api.ts";
import { type ArticleCluster, curateArticles, strongClusters } from "./curate.ts";
import { fetchPublication } from "./fetcher.ts";
import { acquireImages, type ImagePlan } from "./images.ts";
import { LastPickStore, loadPool } from "./pool.ts";
import { type CodexRunner, synthesize, type SynthesisResult } from "./synth.ts";
import { type LogEntry, type Stage, StageError, type SurpriseConfig } from "./surprise.ts";
import { persistMagazine } from "./vault.ts";

const ARCHIVE_LIMIT = 50;
const REUSE_PROB = 0.3; // P(reuse a cached pub's un-pressed theme) vs. pick a fresh publication
const MAX_PICK_ATTEMPTS = 4; // runaway guard: empty/failed/exhausted picks each spend one attempt
const MAX_PRESS_MS = 6 * 60 * 1000; // acquisition-START deadline: stop STARTING new pick attempts past this

export interface PublicationArticles {
  newsletter: string;
  domain: string;
  articles: Post[];
}

export interface DeepDeps {
  newDebugId: () => string;
  log: (entry: LogEntry) => void;
  /** Pick a pool domain, optionally avoiding the given (best-effort) excluded set. */
  pick: (exclude?: ReadonlySet<string>) => Promise<string>;
  fetch: (domain: string) => Promise<PublicationArticles>;
  curate: (articles: Post[]) => Promise<ArticleCluster[]>;
  synth: (newsletter: string, domain: string, cluster: ArticleCluster) => Promise<SynthesisResult>;
  images: (synth: SynthesisResult, posts: Post[], warn: (msg: string) => void) => Promise<ImagePlan>;
  persist: (plan: ImagePlan) => Promise<{ slug: string; dir: string; magazine: Magazine }>;
  random: () => number; // injected for deterministic 70/30 branch + cluster selection in tests
  now: () => number; // injected clock for the acquisition-start deadline
  /** Called once when the press succeeds (SSE per-issue streaming); never on the empty/error path. */
  onMagazine?: (magazine: Magazine) => void;
}

export interface DeepResult {
  debugId: string;
  publication: string;
  magazines: Magazine[]; // 0 (no pub found) or 1 (the pressed magazine)
}

/** Fetched/curated archives + pressed-theme bookkeeping, reused across presses in one session. */
export interface CachedPub {
  newsletter: string;
  clusters: ArticleCluster[];
}
export interface DeepCache {
  pubs: Map<string, CachedPub>; // keyed by RESOLVED domain (post-redirect)
  pressed: Set<string>; // cluster keys already shown: `${resolvedDomain}::${theme}`
}

export function newDeepCache(): DeepCache {
  return { pubs: new Map(), pressed: new Set() };
}

const clusterKey = (domain: string, theme: string): string => `${domain}::${theme}`;

/** Strong clusters of a cached pub whose `(domain, theme)` has NOT been pressed yet. */
function unpressedClusters(cache: DeepCache, domain: string): ArticleCluster[] {
  const pub = cache.pubs.get(domain);
  if (!pub) return [];
  return pub.clusters.filter((c) => !cache.pressed.has(clusterKey(domain, c.theme)));
}

/** Cached resolved domains that still have ≥1 un-pressed strong cluster. */
function reusableDomains(cache: DeepCache): string[] {
  return [...cache.pubs.keys()].filter((d) => unpressedClusters(cache, d).length > 0);
}

const pickAt = <T>(list: T[], rand: number): T => list[Math.min(list.length - 1, Math.floor(rand * list.length))]!;

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

/**
 * Pick → fetch → curate a publication with ≥1 un-pressed strong cluster, caching
 * it (by RESOLVED domain) for reuse. Bounded by MAX_PICK_ATTEMPTS attempts and the
 * MAX_PRESS_MS acquisition-start deadline; a failed/empty/exhausted pick spends one
 * attempt (logged with a reason). A spent pool domain is never re-picked within a
 * press — pool exhaustion returns null rather than re-picking. Returns the resolved
 * domain to press, or null if nothing usable was found.
 */
async function acquireFreshPub(deps: DeepDeps, cache: DeepCache, debugId: string, start: number): Promise<string | null> {
  const excluded = new Set<string>(cache.pubs.keys()); // bias away from already-fetched pubs (best-effort)
  for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
    if (deps.now() > start + MAX_PRESS_MS) {
      deps.log({ debugId, stage: "pick", reason: "deadline" });
      break;
    }
    let picked: string;
    try {
      picked = await timed("pick", deps.log, debugId, () => deps.pick(excluded), (d) => ({ domain: d }));
    } catch {
      continue; // pick threw → spend the attempt (timed already logged the error)
    }
    if (excluded.has(picked)) {
      deps.log({ debugId, stage: "pick", reason: "poolExhausted" });
      break; // only excluded domains remain → stop rather than re-pick a spent one
    }
    excluded.add(picked); // mark spent BEFORE fetch so it is never re-picked this press

    let fetched: PublicationArticles;
    try {
      fetched = await timed("fetch", deps.log, debugId, () => deps.fetch(picked), (f) => ({ domain: f.domain, newsletter: f.newsletter, articles: f.articles.length }));
    } catch {
      continue; // fetch failed → spend the attempt, try the next pick
    }
    const resolved = fetched.domain;
    // Resolved-domain dedupe: a redirect onto an already-cached pub reuses it as-is —
    // no re-curate, no overwrite (the fetch itself was unavoidable to learn `resolved`).
    if (!cache.pubs.has(resolved)) {
      let clusters: ArticleCluster[];
      try {
        const all = await timed("curate", deps.log, debugId, () => deps.curate(fetched.articles), (cs) => ({ articlesIn: fetched.articles.length, clusters: cs.length, strong: strongClusters(cs).length }));
        clusters = strongClusters(all);
      } catch {
        continue; // curate failed → spend the attempt
      }
      cache.pubs.set(resolved, { newsletter: fetched.newsletter, clusters });
    }
    if (unpressedClusters(cache, resolved).length > 0) return resolved;
    // Spend the attempt: a freshly-curated pub with no strong clusters is `noStrongClusters`;
    // a pub that HAD strong clusters but they're all pressed is `exhausted`.
    deps.log({ debugId, stage: "curate", reason: cache.pubs.get(resolved)!.clusters.length === 0 ? "noStrongClusters" : "exhausted", domain: resolved });
  }
  return null;
}

/** Press one (random) un-pressed cluster of a cached pub into a magazine; mark it pressed only after persist. */
async function pressCluster(deps: DeepDeps, cache: DeepCache, domain: string, debugId: string): Promise<Magazine> {
  const pub = cache.pubs.get(domain)!;
  const cluster = pickAt(unpressedClusters(cache, domain), deps.random());
  const warn = (msg: string) => deps.log({ debugId, stage: "images", warn: msg });
  const synth = await timed("synthesize", deps.log, debugId, () => deps.synth(pub.newsletter, domain, cluster), (s) => ({
    theme: cluster.theme,
    articles: cluster.articles.length,
    sections: s.sections.length,
    excerpts: s.sections.reduce((n, sec) => n + sec.excerpts.length, 0),
  }));
  const plan = await timed("images", deps.log, debugId, () => deps.images(synth, cluster.articles, warn), (p) => ({
    theme: cluster.theme,
    withImage: p.sections.filter((sec) => sec.image.kind === "image").length,
  }));
  const saved = await timed("persist", deps.log, debugId, () => deps.persist(plan), (r) => ({ slug: r.slug }));
  cache.pressed.add(clusterKey(domain, cluster.theme));
  return saved.magazine;
}

/**
 * Press ONE deep-dive per call: ~70% a freshly-picked publication, ~30% reuse an
 * un-pressed theme from a cached pub (never repeating a `(resolvedDomain, theme)`).
 * Throws StageError (with debugId) on a PRESS-stage failure; finding no usable pub
 * is a normal empty result (`magazines: []`), not an error.
 */
export async function runDeepDive(deps: DeepDeps, cache: DeepCache, debugId: string = deps.newDebugId()): Promise<DeepResult> {
  const start = deps.now();
  deps.log({ debugId, stage: "start" });
  try {
    const reusable = reusableDomains(cache);
    let domain: string | null;
    if (reusable.length > 0 && deps.random() < REUSE_PROB) {
      domain = pickAt(reusable, deps.random());
    } else {
      domain = await acquireFreshPub(deps, cache, debugId, start);
      if (domain === null && reusable.length > 0) domain = reusable[0]!; // fresh came up empty → fall back to reuse
    }

    if (domain === null) {
      deps.log({ debugId, stage: "done", ms: deps.now() - start, magazines: 0 });
      return { debugId, publication: "", magazines: [] };
    }
    const magazine = await pressCluster(deps, cache, domain, debugId);
    deps.onMagazine?.(magazine);
    deps.log({ debugId, stage: "done", ms: deps.now() - start, magazines: 1 });
    return { debugId, publication: cache.pubs.get(domain)!.newsletter, magazines: [magazine] };
  } catch (error) {
    const stageError = error instanceof StageError ? error : new StageError("pick", error);
    stageError.debugId = debugId;
    throw stageError;
  }
}

// ---- real wiring -----------------------------------------------------------

function defaultLog(entry: LogEntry): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));
}

/**
 * Merge RSS + archive posts into the deep article set: drop paywalled teasers
 * AND body-less stubs (the RSS path emits archive-ref stubs with contentText:""
 * for older posts — keeping one would shadow the same URL's full archive-API body
 * in the dedup, starving curate/synth of the actual text), then dedupe by url
 * preferring the first FULL post seen (RSS bodies lead). Pure + exported so the
 * shadowing guard is unit-tested offline.
 */
export function mergeDeepArticles(rss: Post[], archive: Post[]): Post[] {
  const byUrl = new Map<string, Post>();
  for (const p of [...rss, ...archive]) {
    if (p.locked) continue; // paywalled teaser — no full text
    if (!p.contentText.trim()) continue; // archive-ref stub — no body to curate or cite
    if (!byUrl.has(p.url)) byUrl.set(p.url, p);
  }
  return [...byUrl.values()];
}

/** RSS gives the publication name + recent full posts; the archive API extends it deep. */
async function deepFetch(domain: string, cfg: SurpriseConfig): Promise<PublicationArticles> {
  const feed = await fetchPublication(domain, { fetchImpl: cfg.fetchImpl });
  let archive: Post[] = [];
  try {
    archive = await fetchDeepArticles(feed.domain, { fetchImpl: cfg.fetchImpl, limit: ARCHIVE_LIMIT });
  } catch {
    // archive best-effort — fall back to the RSS posts alone
  }
  return { newsletter: feed.newsletter, domain: feed.domain, articles: mergeDeepArticles(feed.posts, archive) };
}

const runnerOpt = (runner?: CodexRunner) => (runner ? { runner } : {});

/** Bind the real deep-dive stages to a config. */
export function makeDeepDeps(cfg: SurpriseConfig): DeepDeps {
  const store = new LastPickStore(cfg.statePath);
  const log = cfg.log ?? defaultLog;
  return {
    newDebugId: () => randomUUID().slice(0, 8),
    log,
    pick: async (exclude) => store.pick(await loadPool(cfg.poolPath), exclude),
    fetch: (domain) => deepFetch(domain, cfg),
    random: Math.random,
    now: Date.now,
    curate: (articles) => curateArticles(articles, runnerOpt(cfg.runner)),
    synth: (newsletter, domain, cluster) =>
      synthesize(
        { newsletter, domain, feedUrl: "", posts: cluster.articles, archiveOk: true },
        {
          ...runnerOpt(cfg.runner),
          theme: cluster.theme,
          title: cluster.theme,
          // The cluster IS the curated source set — every article must reach the
          // prompt so it CAN be cited. Override budgetPosts' default archive cap
          // (which would silently drop a cluster's 9th+ article since they're all
          // source:"archive") to admit the whole cluster.
          budget: { maxArchive: cluster.articles.length, maxPosts: cluster.articles.length },
        },
      ),
    images: (synth, posts, warn) =>
      acquireImages(synth, posts, {
        googleKey: cfg.googleKey,
        googleCseId: cfg.googleCseId,
        fetchImpl: cfg.fetchImpl,
        warn,
      }),
    persist: (plan) => persistMagazine(plan, { vaultRoot: cfg.vaultRoot, fetchImpl: cfg.fetchImpl, now: cfg.now?.() }),
  };
}
