/**
 * Newsletter pool + random pick (PLAN.md MG2).
 *
 * - `loadPool` reads config/pool.json and canonicalizes + dedupes the domains.
 * - `pickFromPool` is a pure pick that avoids the immediately-previous domain.
 * - `LastPickStore` does the locked, atomic read-modify-write of last-pick state
 *   so concurrent /surprise requests can't corrupt it (review #5).
 * - `parseDiscoverDomains` / `refreshPool` grow the pool from Discover HTML, with
 *   the same atomic-write discipline (R2-#7).
 */
import { readFile } from "node:fs/promises";
import { parse } from "node-html-parser";
import { canonicalizeDomain, isSubstackPublicationHost } from "../shared/domains.ts";
import { atomicWriteFile, Mutex } from "./fsutil.ts";

export interface PoolFile {
  domains: string[];
}

// Serializes pool-file refreshes so two concurrent refreshes can't lose updates
// (atomic write prevents torn files; this prevents read-merge-write races). R2-#7.
const poolRefreshMutex = new Mutex();

/** Read + canonicalize + dedupe the pool. Order preserved (minus duplicates). */
export async function loadPool(poolPath: string): Promise<string[]> {
  const raw = await readFile(poolPath, "utf8");
  const data = JSON.parse(raw) as PoolFile;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of data.domains ?? []) {
    const host = canonicalizeDomain(entry);
    if (host && !seen.has(host)) {
      seen.add(host);
      out.push(host);
    }
  }
  return out;
}

/**
 * Pick a domain at random, avoiding `lastPick` and any `exclude`d domains when the
 * pool has alternatives. When every alternative is excluded the pool is "exhausted":
 * we fall back to the full pool, so the caller can detect exhaustion by noticing the
 * returned domain is itself excluded. `rand` is injectable for deterministic tests.
 */
export function pickFromPool(
  pool: string[],
  lastPick: string | null,
  rand: () => number = Math.random,
  exclude?: ReadonlySet<string>,
): string {
  if (pool.length === 0) throw new Error("pickFromPool: empty pool");
  if (pool.length === 1) return pool[0]!;
  // `exclude` is a HARD constraint (spent this press); `lastPick` is only a SOFT one
  // (variety). Apply exclude first; if every domain is excluded, fall back to the full
  // pool so the returned (excluded) domain signals exhaustion to the caller. Then avoid
  // `lastPick` only when another option remains.
  const notExcluded = pool.filter((d) => !(exclude?.has(d) ?? false));
  const base = notExcluded.length > 0 ? notExcluded : pool;
  const avoidLast = base.filter((d) => d !== lastPick);
  const list = avoidLast.length > 0 ? avoidLast : base;
  const idx = Math.min(list.length - 1, Math.floor(rand() * list.length));
  return list[idx]!;
}

/** Locked, atomic store for the most-recently-picked domain. */
export class LastPickStore {
  private readonly mutex = new Mutex();

  constructor(private readonly statePath: string) {}

  /** Current last-pick, or null if unset/unreadable (atomic writes => never torn). */
  async read(): Promise<string | null> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const value = (JSON.parse(raw) as { lastPick?: string }).lastPick;
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  /** Serialized read-modify-write: pick avoiding the previous (+ excluded), persist atomically. */
  pick(pool: string[], exclude?: ReadonlySet<string>, rand: () => number = Math.random): Promise<string> {
    return this.mutex.run(async () => {
      const last = await this.read();
      const choice = pickFromPool(pool, last, rand, exclude);
      await atomicWriteFile(this.statePath, JSON.stringify({ lastPick: choice }) + "\n");
      return choice;
    });
  }
}

/** Convenience: load the pool and pick via the store in one call. */
export async function pickNewsletter(poolPath: string, store: LastPickStore): Promise<string> {
  return store.pick(await loadPool(poolPath));
}

/** Extract harvestable Substack publication domains from Discover HTML (deduped). */
export function parseDiscoverDomains(html: string): string[] {
  const root = parse(html);
  const seen = new Set<string>();
  for (const anchor of root.querySelectorAll("a")) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    const host = canonicalizeDomain(href);
    if (host && isSubstackPublicationHost(host)) seen.add(host);
  }
  return [...seen];
}

/**
 * Merge newly-discovered domains into the pool file (deduped, sorted), writing
 * atomically only if something changed. Returns counts for observability.
 */
export async function refreshPool(
  poolPath: string,
  discoverHtml: string,
): Promise<{ added: number; total: number }> {
  // Whole read-merge-write under the lock so concurrent refreshes can't clobber
  // each other (last-writer-wins). atomicWriteFile then guards against torn files.
  return poolRefreshMutex.run(async () => {
    const existing = await loadPool(poolPath);
    const set = new Set(existing);
    let added = 0;
    for (const host of parseDiscoverDomains(discoverHtml)) {
      if (!set.has(host)) {
        set.add(host);
        added += 1;
      }
    }
    if (added > 0) {
      const domains = [...set].toSorted();
      await atomicWriteFile(poolPath, JSON.stringify({ domains }, null, 2) + "\n");
    }
    return { added, total: set.size };
  });
}
