import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LastPickStore,
  loadPool,
  parseDiscoverDomains,
  pickFromPool,
  refreshPool,
} from "./pool.ts";

const DISCOVER_FIXTURE = join(import.meta.dir, "../../fixtures/discover.html");

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pool-test-"));
}

describe("loadPool", () => {
  test("canonicalizes and dedupes the seed list", async () => {
    const dir = await tmp();
    const path = join(dir, "pool.json");
    await writeFile(
      path,
      JSON.stringify({ domains: ["https://www.Foo.com/x", "foo.com", "bar.substack.com"] }),
    );
    expect(await loadPool(path)).toEqual(["foo.com", "bar.substack.com"]);
  });

  test("the shipped seed pool loads and has a healthy size", async () => {
    const path = join(import.meta.dir, "../../config/pool.json");
    const pool = await loadPool(path);
    // Curated brainfood seed — deliberately tighter/higher-quality than a broad
    // pool; auto-discovery grows the directory at runtime.
    expect(pool.length).toBeGreaterThanOrEqual(18);
    expect(new Set(pool).size).toBe(pool.length); // no dupes after canonicalize
  });
});

describe("pickFromPool", () => {
  const pool = ["a.com", "b.com", "c.com", "d.com"];

  test("never returns the last pick and always returns a pool member (300 draws)", () => {
    const last = "b.com";
    for (let i = 0; i < 300; i++) {
      const pick = pickFromPool(pool, last);
      expect(pick).not.toBe(last);
      expect(pool).toContain(pick);
    }
  });

  test("single-element pool returns its only member", () => {
    expect(pickFromPool(["only.com"], "only.com")).toBe("only.com");
  });

  test("honors an injected rand for determinism", () => {
    expect(pickFromPool(pool, null, () => 0)).toBe("a.com");
    expect(pickFromPool(pool, null, () => 0.999)).toBe("d.com");
  });

  test("excludes the given domains (hard) and never returns one when alternatives exist (300 draws)", () => {
    const exclude = new Set(["a.com", "b.com"]);
    for (let i = 0; i < 300; i++) {
      expect(["c.com", "d.com"]).toContain(pickFromPool(pool, null, Math.random, exclude));
    }
  });

  test("exclude is HARD but lastPick is SOFT: returns the lastPick rather than a spent (excluded) domain", () => {
    // Only c.com is un-excluded, but it is also the lastPick. lastPick must yield to the
    // hard exclusion rather than forcing a fall-back that could return a spent domain.
    const exclude = new Set(["a.com", "b.com", "d.com"]);
    expect(pickFromPool(pool, "c.com", () => 0, exclude)).toBe("c.com");
  });

  test("when EVERY domain is excluded, returns an excluded domain so the caller can detect exhaustion", () => {
    const exclude = new Set(pool);
    expect(exclude.has(pickFromPool(pool, null, () => 0, exclude))).toBe(true);
  });

  test("throws on an empty pool", () => {
    expect(() => pickFromPool([], null)).toThrow();
  });
});

describe("LastPickStore — concurrency & atomicity", () => {
  test("50 parallel picks leave last-pick state valid and a pool member", async () => {
    const dir = await tmp();
    const statePath = join(dir, "last-pick.json");
    const pool = ["a.com", "b.com", "c.com", "d.com", "e.com"];
    const store = new LastPickStore(statePath);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => store.pick(pool)),
    );

    for (const r of results) expect(pool).toContain(r);

    // The state file must be valid JSON (never torn) and a pool member.
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as { lastPick: string };
    expect(pool).toContain(parsed.lastPick);
  });

  test("sequential picks avoid the immediately-previous", async () => {
    const dir = await tmp();
    const store = new LastPickStore(join(dir, "last-pick.json"));
    const pool = ["a.com", "b.com", "c.com"];
    let prev: string | null = null;
    for (let i = 0; i < 30; i++) {
      const pick = await store.pick(pool);
      if (prev !== null) expect(pick).not.toBe(prev);
      prev = pick;
    }
  });
});

describe("parseDiscoverDomains", () => {
  test("extracts only harvestable publication subdomains, deduped", async () => {
    const html = await readFile(DISCOVER_FIXTURE, "utf8");
    const domains = parseDiscoverDomains(html).toSorted();
    expect(domains).toEqual(["bar.substack.com", "baz.substack.com", "foo.substack.com"]);
  });
});

describe("refreshPool", () => {
  test("adds new deduped domains and is idempotent on re-run", async () => {
    const dir = await tmp();
    const path = join(dir, "pool.json");
    await writeFile(path, JSON.stringify({ domains: ["bar.substack.com", "existing.com"] }));
    const html = await readFile(DISCOVER_FIXTURE, "utf8");

    const first = await refreshPool(path, html); // adds foo + baz (bar already present)
    expect(first.added).toBe(2);
    expect(first.total).toBe(4);

    const after = await loadPool(path);
    expect(after).toContain("foo.substack.com");
    expect(after).toContain("baz.substack.com");

    const second = await refreshPool(path, html); // nothing new
    expect(second.added).toBe(0);
    expect(second.total).toBe(4);
  });

  test("concurrent refreshes don't lose updates (locked read-merge-write)", async () => {
    const dir = await tmp();
    const path = join(dir, "pool.json");
    await writeFile(path, JSON.stringify({ domains: [] }));
    const htmlA = `<a href="https://one.substack.com">1</a><a href="https://two.substack.com">2</a>`;
    const htmlB = `<a href="https://three.substack.com">3</a><a href="https://four.substack.com">4</a>`;

    // Run two refreshes with disjoint domain sets in parallel. Without the mutex
    // one merge could clobber the other; with it, the final pool is the union.
    await Promise.all([refreshPool(path, htmlA), refreshPool(path, htmlB)]);

    const final = await loadPool(path);
    expect(final.toSorted()).toEqual([
      "four.substack.com",
      "one.substack.com",
      "three.substack.com",
      "two.substack.com",
    ]);
  });
});
