import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Magazine } from "../shared/magazine.ts";
import type { FetchResult } from "../shared/post.ts";
import type { ImagePlan } from "./images.ts";
import type { SynthesisResult } from "./synth.ts";
import {
  InFlightGuard,
  type LogEntry,
  makeSurpriseDeps,
  runSurprise,
  StageError,
  type SurpriseDeps,
} from "./surprise.ts";

// ---- canned stage data for the unit-level fakes ----------------------------

const MAG: Magazine = {
  id: "daily-curio-2026-06-01",
  newsletter: "Daily Curio",
  newsletterUrl: "https://daily-curio.substack.com",
  title: "Daily Curio",
  intro: "A field guide.",
  themes: ["history"],
  vibePresetId: "vintage-science",
  accentColor: "#8a3b2f",
  sections: [{ heading: "Skyward", prose: "Tissue.", excerpts: [{ text: "q", sourceUrl: "https://x/p/1", sourceTitle: "P" }], images: [] }],
  generatedAt: "2026-06-01T00:00:00.000Z",
};

const FETCHED: FetchResult = {
  newsletter: "Daily Curio",
  domain: "daily-curio.substack.com",
  feedUrl: "https://daily-curio.substack.com/feed",
  posts: [],
  archiveOk: false,
};
const SYNTH: SynthesisResult = {
  newsletter: "Daily Curio", domain: "daily-curio.substack.com", intro: "A field guide.",
  themes: ["history"], vibePresetId: "vintage-science", accentColor: "#8a3b2f",
  imageQueries: ["clouds"], sections: [{ heading: "Skyward", prose: "Tissue.", excerpts: [] }],
};
const PLAN: ImagePlan = { ...SYNTH, usedCse: false, sections: [{ heading: "Skyward", prose: "Tissue.", excerpts: [], image: { kind: "typographic" } }] };

// Fake codex output for the e2e test: excerpts are verbatim substrings of the
// image-free posts 3 & 4 in fixtures/feed.xml (so anti-fabrication passes and no
// image bytes are ever fetched — the run stays fully offline).
const FAKE_SPEC = JSON.stringify({
  intro: "Weird and wonderful knowledge.",
  themes: ["history", "nature"],
  sections: [
    { heading: "Dyes", prose: "Connective tissue about color.", excerpts: [{ postId: "post-0003", text: "ten thousand sea snails" }] },
    { heading: "Minds", prose: "Connective tissue about animals.", excerpts: [{ postId: "post-0004", text: "Honeybees can solve simple arithmetic" }] },
  ],
  vibePresetId: "vintage-science",
  accentColor: "#8a3b2f",
  imageQueries: ["sea snails", "honeybee"],
});

/** Assert the full runtime shape + types of an assembled Magazine. */
function expectMagazineShape(mag: Magazine): void {
  for (const key of ["id", "newsletter", "newsletterUrl", "title", "intro", "vibePresetId", "accentColor", "generatedAt"] as const) {
    expect(typeof mag[key]).toBe("string");
    expect(mag[key].length).toBeGreaterThan(0);
  }
  expect(Array.isArray(mag.themes)).toBe(true);
  expect(mag.themes.every((t) => typeof t === "string")).toBe(true);
  expect(mag.accentColor).toMatch(/^#[0-9a-fA-F]{6}$/);
  expect(new Date(mag.generatedAt).toISOString()).toBe(mag.generatedAt);
  expect(mag.sections.length).toBeGreaterThan(0);
  for (const s of mag.sections) {
    expect(typeof s.heading).toBe("string");
    expect(typeof s.prose).toBe("string");
    for (const ex of s.excerpts) {
      expect(typeof ex.text).toBe("string");
      expect(typeof ex.sourceUrl).toBe("string");
      expect(typeof ex.sourceTitle).toBe("string");
    }
    for (const img of s.images) {
      expect(typeof img.src).toBe("string");
      expect(img.src.startsWith("images/")).toBe(true); // local, offline-safe path
      expect(typeof img.alt).toBe("string");
    }
  }
}

function fakeDeps(over: Partial<SurpriseDeps> = {}): { deps: SurpriseDeps; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  const deps: SurpriseDeps = {
    newDebugId: () => "dbg-1234",
    log: (e) => logs.push(e),
    pick: async () => "daily-curio.substack.com",
    fetch: async () => FETCHED,
    synth: async () => SYNTH,
    images: async () => PLAN,
    persist: async () => ({ slug: "daily-curio-2026-06-01", dir: "/tmp/x", magazine: MAG }),
    ...over,
  };
  return { deps, logs };
}

describe("runSurprise — orchestration", () => {
  test("chains all stages and returns the persisted magazine + debugId", async () => {
    const { deps } = fakeDeps();
    const res = await runSurprise(deps);
    expect(res.debugId).toBe("dbg-1234");
    expect(res.magazine.newsletter).toBe("Daily Curio");
    expect(res.slug).toBe("daily-curio-2026-06-01");
  });

  test("passes each stage's output to the next", async () => {
    const seen: { synth?: FetchResult; images?: SynthesisResult } = {};
    const { deps } = fakeDeps({
      synth: async (f) => { seen.synth = f; return SYNTH; },
      images: async (s) => { seen.images = s; return PLAN; },
    });
    await runSurprise(deps);
    expect(seen.synth).toBe(FETCHED);
    expect(seen.images).toBe(SYNTH);
  });

  test("logs start + every stage + done under ONE shared debugId, each timed", async () => {
    const { deps, logs } = fakeDeps();
    await runSurprise(deps);
    expect(logs.map((l) => l.stage)).toEqual(["start", "pick", "fetch", "synthesize", "images", "persist", "done"]);
    expect(logs.every((l) => l.debugId === "dbg-1234")).toBe(true);
    for (const stage of ["pick", "fetch", "synthesize", "images", "persist"]) {
      const entry = logs.find((l) => l.stage === stage)!;
      expect(typeof entry.ms).toBe("number");
    }
  });

  test("a failing stage throws a StageError naming the stage + carrying the debugId", async () => {
    const boom = new Error("feed fetch failed");
    const { deps, logs } = fakeDeps({ fetch: async () => { throw boom; } });
    try {
      await runSurprise(deps);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(StageError);
      const se = e as StageError;
      expect(se.stage).toBe("fetch");
      expect(se.debugId).toBe("dbg-1234");
      expect(se.cause).toBe(boom);
    }
    // The failing stage was logged with its error and downstream stages did not run.
    expect(logs.find((l) => l.stage === "fetch")!.error).toBe("feed fetch failed");
    expect(logs.some((l) => l.stage === "synthesize")).toBe(false);
  });
});

describe("InFlightGuard", () => {
  test("admits one holder and rejects until released", () => {
    const g = new InFlightGuard();
    expect(g.tryAcquire()).toBe(true);
    expect(g.tryAcquire()).toBe(false);
    g.release();
    expect(g.tryAcquire()).toBe(true);
  });
});

// ---- end-to-end through the REAL wired stages, offline on fixtures ----------

describe("makeSurpriseDeps — end-to-end on fixtures (injected fetch + fake codex)", () => {
  test("picks, fetches, synthesizes, plans images, and auto-saves a schema-valid magazine", async () => {
    const root = await mkdtemp(join(tmpdir(), "surprise-e2e-"));
    const poolPath = join(root, "pool.json");
    const statePath = join(root, "state.json");
    const vaultRoot = join(root, "library");
    await writeFile(poolPath, JSON.stringify({ domains: ["daily-curio.substack.com"] }));
    const feedXml = await readFile(join(import.meta.dir, "../../fixtures/feed.xml"), "utf8");

    // Serve the RSS feed; 404 the archive (graceful). No image bytes are fetched
    // because the chosen excerpts come from image-free posts -> typographic.
    const fetchImpl = (async (input: string | URL | Request) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (u.includes("/feed")) {
        return new Response(feedXml, { status: 200, headers: { "content-type": "application/rss+xml" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const logs: LogEntry[] = [];
    const deps = makeSurpriseDeps({
      poolPath, statePath, vaultRoot, fetchImpl,
      runner: async () => FAKE_SPEC,
      now: () => "2026-06-01T00:00:00.000Z",
      log: (e) => logs.push(e),
    });

    const res = await runSurprise(deps);

    // schema-valid Magazine — assert the COMPLETE runtime shape, not a few fields.
    const mag = res.magazine;
    expectMagazineShape(mag);
    expect(mag.newsletter).toBe("Daily Curio");
    expect(mag.newsletterUrl).toBe("https://daily-curio.substack.com");
    expect(mag.sections.length).toBe(2);
    expect(mag.sections.every((s) => s.excerpts.length > 0)).toBe(true);
    expect(mag.sections[0]!.excerpts[0]!.sourceUrl).toBe("https://daily-curio.substack.com/p/tyrian-purple");
    expect(mag.vibePresetId).toBe("vintage-science");

    // auto-saved vault entry
    expect(existsSync(join(res.dir, "magazine.json"))).toBe(true);
    expect(existsSync(join(res.dir, "index.md"))).toBe(true);
    const manifest = JSON.parse(await readFile(join(res.dir, "manifest.json"), "utf8")) as { status: string };
    expect(manifest.status).toBe("complete");

    // last-pick state was recorded
    expect(JSON.parse(await readFile(statePath, "utf8")).lastPick).toBe("daily-curio.substack.com");

    // observability covered the whole pipeline
    expect(logs.find((l) => l.stage === "done")).toBeDefined();
  });
});
