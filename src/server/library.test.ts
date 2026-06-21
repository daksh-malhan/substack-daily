import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Magazine } from "../shared/magazine.ts";
import type { ImagePlan, PlannedSection } from "./images.ts";
import { persistMagazine } from "./vault.ts";
import { deleteEntry, listLibrary, readMagazine, resolveAsset, validateEntryId } from "./library.ts";
import { handleRequest, type SurpriseContext } from "./app.ts";
import { type DeepDeps, newDeepCache } from "./deep.ts";
import { InFlightGuard } from "./surprise.ts";

// ---- fixtures: build a real vault with persistMagazine ----------------------

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(26);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  b[16] = (w >>> 24) & 255; b[17] = (w >>> 16) & 255; b[18] = (w >>> 8) & 255; b[19] = w & 255;
  b[20] = (h >>> 24) & 255; b[21] = (h >>> 16) & 255; b[22] = (h >>> 8) & 255; b[23] = h & 255;
  b[24] = 8; b[25] = 2;
  return b;
}
const okFetch = (async () => new Response(new Blob([png(300, 300) as BufferSource]))) as unknown as typeof fetch;

function section(): PlannedSection {
  return {
    heading: "Mind",
    prose: "Connective tissue.",
    excerpts: [{ text: "a real quote", sourceUrl: "https://x.substack.com/p/1", sourceTitle: "Post One", postId: "p1" }],
    image: { kind: "image", candidate: { url: "http://93.184.216.34/a.png", source: "post", alt: "alt" } },
  };
}
function plan(over: Partial<ImagePlan> = {}): ImagePlan {
  return {
    newsletter: "Daily Curio", domain: "daily-curio.substack.com", intro: "A field guide.",
    themes: ["consciousness"], vibePresetId: "vintage-science", accentColor: "#8a3b2f",
    imageQueries: [], usedCse: false, sections: [section()], ...over,
  };
}

async function newVault(): Promise<string> {
  return mkdtemp(join(tmpdir(), "library-test-"));
}
async function seed(vaultRoot: string, newsletter: string, slug: string, now = "2026-06-01T00:00:00.000Z"): Promise<string> {
  await persistMagazine(plan({ newsletter }), { vaultRoot, fetchImpl: okFetch, now, slug });
  return slug;
}

// ---- validateEntryId (the trust boundary) ----------------------------------

describe("validateEntryId", () => {
  test("accepts a clean slug, rejects everything unsafe", () => {
    expect(validateEntryId("daily-curio-2026-06-01")).toBe("daily-curio-2026-06-01");
    for (const bad of ["..", "../etc", "a/b", ".hidden", "themes", "newsletters", "Daily-Curio", "a b", "", "café"]) {
      expect(validateEntryId(bad)).toBeNull();
    }
  });
});

// ---- listLibrary -----------------------------------------------------------

describe("listLibrary", () => {
  test("lists complete magazines newest-first; skips incomplete/.tmp/reserved/dotfiles", async () => {
    const root = await newVault();
    await seed(root, "Alpha", "alpha-2026-06-01", "2026-06-01T00:00:00.000Z");
    await seed(root, "Beta", "beta-2026-06-02", "2026-06-02T00:00:00.000Z");
    // noise that must be ignored:
    await mkdir(join(root, ".hidden"), { recursive: true });
    await mkdir(join(root, "incomplete"), { recursive: true });
    await writeFile(join(root, "incomplete", "manifest.json"), JSON.stringify({ status: "pending" }));

    const list = await listLibrary(root);
    expect(list.map((e) => e.id)).toEqual(["beta-2026-06-02", "alpha-2026-06-01"]); // newest first
    expect(list.every((e) => e.title && e.newsletter)).toBe(true);
    expect(list.some((e) => e.id === "incomplete")).toBe(false);
  });

  test("returns [] for a missing vault", async () => {
    expect(await listLibrary(join(tmpdir(), "does-not-exist-xyz"))).toEqual([]);
  });

  test("a complete entry with malformed or id-mismatched magazine.json is skipped, not served", async () => {
    const root = await newVault();
    await seed(root, "Good", "good-2026-06-01");
    // complete manifest but a magazine.json of the wrong shape
    await mkdir(join(root, "broken"), { recursive: true });
    await writeFile(join(root, "broken", "manifest.json"), JSON.stringify({ status: "complete" }));
    await writeFile(join(root, "broken", "magazine.json"), JSON.stringify({ id: "broken", title: 123 }));
    // valid shape but its id claims to be ANOTHER entry (can't impersonate)
    await mkdir(join(root, "imposter"), { recursive: true });
    await writeFile(join(root, "imposter", "manifest.json"), JSON.stringify({ status: "complete" }));
    const good = JSON.parse(await readFile(join(root, "good-2026-06-01", "magazine.json"), "utf8")) as Magazine;
    await writeFile(join(root, "imposter", "magazine.json"), JSON.stringify({ ...good, id: "good-2026-06-01" }));

    expect((await listLibrary(root)).map((e) => e.id)).toEqual(["good-2026-06-01"]);
    expect(await readMagazine(root, "broken")).toBeNull();
    expect(await readMagazine(root, "imposter")).toBeNull();
  });
});

// ---- readMagazine ----------------------------------------------------------

describe("readMagazine", () => {
  test("reads a complete magazine, rejects bad/incomplete/missing ids", async () => {
    const root = await newVault();
    await seed(root, "Alpha", "alpha-2026-06-01");
    const mag = await readMagazine(root, "alpha-2026-06-01");
    expect(mag?.newsletter).toBe("Alpha");
    expect(await readMagazine(root, "../../etc/passwd")).toBeNull();
    expect(await readMagazine(root, "nope")).toBeNull();
  });
});

// ---- resolveAsset (the file-serving boundary) ------------------------------

describe("resolveAsset", () => {
  test("resolves a real image, rejects traversal / non-image / outside images/", async () => {
    const root = await newVault();
    await seed(root, "Alpha", "alpha-2026-06-01");
    const mag = JSON.parse(await readFile(join(root, "alpha-2026-06-01", "magazine.json"), "utf8")) as Magazine;
    const rel = mag.sections[0]!.images[0]!.src; // "images/<hash>.png"

    const ok = await resolveAsset(root, "alpha-2026-06-01", rel);
    expect(ok?.contentType).toBe("image/png");
    expect(ok?.absPath.endsWith(rel)).toBe(true);

    for (const bad of [
      "images/../../secret.png", // traversal
      "../alpha-2026-06-01/images/x.png", // climb out of images
      "manifest.json", // not under images/
      "images/.hidden.png", // dotfile
      "images/notes.txt", // non-image extension
      "images", // not a file path
      "images/a/b.png", // too deep
    ]) {
      expect(await resolveAsset(root, "alpha-2026-06-01", bad)).toBeNull();
    }
    expect(await resolveAsset(root, "../../etc", "images/x.png")).toBeNull(); // bad id
  });
});

// ---- deleteEntry -----------------------------------------------------------

describe("deleteEntry", () => {
  test("deletes by valid id and reconciles; rejects invalid / missing", async () => {
    const root = await newVault();
    await seed(root, "Solo", "solo-2026-06-01");
    expect(existsSync(join(root, "solo-2026-06-01"))).toBe(true);

    expect(await deleteEntry(root, "../../etc")).toBe("invalid");
    expect(await deleteEntry(root, "ghost")).toBe("not-found");
    expect(await deleteEntry(root, "solo-2026-06-01")).toBe("ok");
    expect(existsSync(join(root, "solo-2026-06-01"))).toBe(false);
    // the now-orphaned theme note was pruned by reconcile
    expect(existsSync(join(root, "themes", "consciousness.md"))).toBe(false);
  });
});

// ---- route level (handleRequest) -------------------------------------------

const HOST = "127.0.0.1:4321";
function ctxFor(vaultRoot: string): SurpriseContext {
  return { deps: undefined as unknown as DeepDeps, guard: new InFlightGuard(), cache: newDeepCache(), vaultRoot };
}
function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://${HOST}${path}`, { method: "GET", headers: { host: HOST, ...headers } });
}

describe("library routes — happy + offline", () => {
  test("GET /api/library lists, GET /api/library/:id reads, asset route serves the image", async () => {
    const root = await newVault();
    await seed(root, "Alpha", "alpha-2026-06-01");
    const ctx = ctxFor(root);

    const list = (await (await handleRequest(get("/api/library"), ctx)).json()) as { id: string }[];
    expect(list[0]!.id).toBe("alpha-2026-06-01");

    const magRes = await handleRequest(get("/api/library/alpha-2026-06-01"), ctx);
    expect(magRes.status).toBe(200);
    const mag = (await magRes.json()) as Magazine;
    const rel = mag.sections[0]!.images[0]!.src;

    const assetRes = await handleRequest(get(`/library-assets/alpha-2026-06-01/${rel}`), ctx);
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get("content-type")).toBe("image/png");
    expect((await assetRes.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});

describe("library routes — security", () => {
  test("asset route rejects percent-encoded traversal, dotfiles, non-images, bad/incomplete ids", async () => {
    const root = await newVault();
    await seed(root, "Alpha", "alpha-2026-06-01");
    await mkdir(join(root, "incomplete", "images"), { recursive: true });
    await writeFile(join(root, "incomplete", "manifest.json"), JSON.stringify({ status: "pending" }));
    await writeFile(join(root, "incomplete", "images", "x.png"), png(300, 300));
    const ctx = ctxFor(root);

    for (const path of [
      "/library-assets/alpha-2026-06-01/images/..%2f..%2fmanifest.json",
      "/library-assets/alpha-2026-06-01/manifest.json",
      "/library-assets/alpha-2026-06-01/images/.hidden.png",
      "/library-assets/incomplete/images/x.png", // not a complete entry
      "/library-assets/..%2f..%2fetc/images/x.png", // bad id
    ]) {
      const res = await handleRequest(get(path), ctx);
      expect(res.status === 404 || res.status === 400).toBe(true);
    }
  });

  test("a cross-site asset request (Sec-Fetch-Site) is rejected even when it omits Origin", async () => {
    const root = await newVault();
    await seed(root, "Alpha", "alpha-2026-06-01");
    const res = await handleRequest(
      get("/library-assets/alpha-2026-06-01/images/x.png", { "sec-fetch-site": "cross-site" }),
      ctxFor(root),
    );
    expect(res.status).toBe(403); // blocked before any file work, no Origin needed
  });

  test("a crafted out-of-vault DELETE id is rejected; cross-origin reads are blocked", async () => {
    const root = await newVault();
    await seed(root, "Alpha", "alpha-2026-06-01");
    const ctx = ctxFor(root);

    const del = (path: string, origin: string) =>
      handleRequest(new Request(`http://${HOST}${path}`, {
        method: "DELETE", headers: { host: HOST, origin, "content-type": "application/json" }, body: "{}",
      }), ctx);

    // traversal id -> 400 invalid, nothing deleted
    expect((await del("/api/library/..%2f..%2fetc", `http://${HOST}`)).status).toBe(400);
    expect(existsSync(join(root, "alpha-2026-06-01"))).toBe(true);

    // cross-origin asset read -> 403 (securityCheck), before any file work
    expect((await handleRequest(get("/library-assets/alpha-2026-06-01/images/x.png", { origin: "https://evil.example.com" }), ctx)).status).toBe(403);
    // cross-origin library JSON read -> 403
    expect((await handleRequest(get("/api/library", { origin: "https://evil.example.com" }), ctx)).status).toBe(403);

    // valid same-origin delete works
    expect((await del("/api/library/alpha-2026-06-01", `http://${HOST}`)).status).toBe(200);
    expect(existsSync(join(root, "alpha-2026-06-01"))).toBe(false);
  });

  test("a DELETE that hits an I/O error returns a clean JSON 500 (no path leak)", async () => {
    const root = await newVault();
    await seed(root, "Alpha", "alpha-2026-06-01");
    await chmod(root, 0o500); // read-only vault dir -> removing the entry throws EACCES
    try {
      const res = await handleRequest(
        new Request(`http://${HOST}/api/library/alpha-2026-06-01`, {
          method: "DELETE", headers: { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" }, body: "{}",
        }),
        ctxFor(root),
      );
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain(root); // no filesystem path leaked
      expect((body as { error?: string }).error).toBeDefined();
    } finally {
      await chmod(root, 0o700); // restore so the temp dir can be cleaned up
    }
  });
});
