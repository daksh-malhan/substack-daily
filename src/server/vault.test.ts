import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Magazine } from "../shared/magazine.ts";
import type { ImagePlan, PlannedSection } from "./images.ts";
import { persistMagazine, reconcileNotes, renderIndexMd } from "./vault.ts";

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
function imgResponse(bytes: Uint8Array, init?: ResponseInit): Response {
  return new Response(new Blob([bytes as BufferSource]), init);
}
const okFetch = (async () => imgResponse(png(300, 300))) as unknown as typeof fetch;
const failFetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;

async function vault(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vault-test-"));
}

function imageUrl(host = "93.184.216.34", name = "a.png"): string {
  return `http://${host}/${name}`;
}

function section(heading: string, imgUrl: string | null): PlannedSection {
  return {
    heading,
    prose: "Connective tissue.",
    excerpts: [{ text: "a real quote", sourceUrl: "https://x.substack.com/p/1", sourceTitle: "Post One", postId: "p1" }],
    image: imgUrl ? { kind: "image", candidate: { url: imgUrl, source: "post", alt: "alt" } } : { kind: "typographic" },
  };
}

function plan(over: Partial<ImagePlan> = {}): ImagePlan {
  return {
    newsletter: "Daily Curio",
    domain: "daily-curio.substack.com",
    intro: "A field guide.",
    themes: ["consciousness", "neuroscience"],
    vibePresetId: "vintage-science",
    accentColor: "#8a3b2f",
    imageQueries: [],
    usedCse: false,
    sections: [section("Mind", imageUrl())],
    ...over,
  };
}

describe("renderIndexMd", () => {
  const mag: Magazine = {
    id: "x", newsletter: "Daily Curio", newsletterUrl: "https://d.substack.com",
    title: "Daily Curio", intro: "Intro.", themes: ["consciousness"],
    vibePresetId: "zine", accentColor: "#000000", generatedAt: "2026-06-01T00:00:00.000Z",
    sections: [{
      heading: "Mind", prose: "Prose.",
      excerpts: [{ text: "a quote", sourceUrl: "https://x/p/1", sourceTitle: "Post" }],
      images: [{ src: "images/abc.png", alt: "alt" }],
    }],
  };
  const md = renderIndexMd(mag, [{ slug: "consciousness", name: "consciousness" }], { slug: "daily-curio", name: "Daily Curio" });

  test("embeds local images and blockquotes excerpts with source links", () => {
    expect(md).toContain("![[images/abc.png]]");
    expect(md).toContain("> a quote");
    expect(md).toContain("> — [Post](https://x/p/1)");
  });
  test("links themes and newsletter for the graph", () => {
    expect(md).toContain("[[themes/consciousness|consciousness]]");
    expect(md).toContain("[[newsletters/daily-curio|Daily Curio]]");
  });
});

describe("persistMagazine — atomic publish", () => {
  test("writes a complete magazine folder with local image paths", async () => {
    const root = await vault();
    const res = await persistMagazine(plan(), { vaultRoot: root, fetchImpl: okFetch, now: "2026-06-01T00:00:00.000Z" });

    expect(existsSync(join(res.dir, "index.md"))).toBe(true);
    expect(existsSync(join(res.dir, "manifest.json"))).toBe(true);
    const mag = JSON.parse(await readFile(join(res.dir, "magazine.json"), "utf8")) as Magazine;
    expect(mag.sections[0]!.images[0]!.src).toStartWith("images/");
    expect(existsSync(join(res.dir, mag.sections[0]!.images[0]!.src))).toBe(true);

    const manifest = JSON.parse(await readFile(join(res.dir, "manifest.json"), "utf8")) as { status: string };
    expect(manifest.status).toBe("complete");

    // .tmp must be empty (renamed away), so the Library never sees a partial.
    const tmp = join(root, ".tmp");
    if (existsSync(tmp)) expect((await readdir(tmp)).length).toBe(0);
  });

  test("gracefully renders typographically when images fail to download", async () => {
    const root = await vault();
    const res = await persistMagazine(plan(), { vaultRoot: root, fetchImpl: failFetch, now: "2026-06-01T00:00:00.000Z" });
    const mag = JSON.parse(await readFile(join(res.dir, "magazine.json"), "utf8")) as Magazine;
    expect(mag.sections[0]!.images).toEqual([]);
    expect(existsSync(join(res.dir, "index.md"))).toBe(true);
  });

  test("a long deep-dive title yields a safe, bounded slug; an unslugifiable one falls back", async () => {
    const root = await vault();
    const long = await persistMagazine(
      plan({ title: `How ${"verylongword ".repeat(40)}domesticates rebellion` }),
      { vaultRoot: root, fetchImpl: failFetch, now: "2026-06-01T00:00:00.000Z" },
    );
    expect(long.slug.length).toBeLessThan(100); // truncated, never a filesystem-limit abort
    expect(long.slug).toMatch(/^[a-z0-9-]+$/);
    const emoji = await persistMagazine(
      plan({ title: "🌀🌀🌀", newsletter: "Daily Curio" }),
      { vaultRoot: root, fetchImpl: failFetch, now: "2026-06-02T00:00:00.000Z" },
    );
    expect(emoji.slug).toContain("daily-curio"); // falls back to the publication, doesn't throw
  });

  test("dedupes identical images by content hash", async () => {
    const root = await vault();
    const url = imageUrl();
    const res = await persistMagazine(
      plan({ sections: [section("A", url), section("B", url)] }),
      { vaultRoot: root, fetchImpl: okFetch, now: "2026-06-01T00:00:00.000Z" },
    );
    const files = await readdir(join(res.dir, "images"));
    expect(files.length).toBe(1); // same bytes -> one file
    const mag = JSON.parse(await readFile(join(res.dir, "magazine.json"), "utf8")) as Magazine;
    expect(mag.sections[0]!.images[0]!.src).toBe(mag.sections[1]!.images[0]!.src);
  });
});

describe("persistMagazine — atomicity & budget", () => {
  test("a failed publish leaves no half-valid magazine and cleans .tmp", async () => {
    const root = await vault();
    // Pre-create the target slug as a FILE so the final rename fails mid-persist.
    const slug = "daily-curio-2026-06-01";
    await writeFile(join(root, slug), "i am a file, not a magazine dir");
    await expect(
      persistMagazine(plan(), { vaultRoot: root, fetchImpl: okFetch, now: "2026-06-01T00:00:00.000Z", slug }),
    ).rejects.toThrow();
    // The pre-existing file is untouched; no magazine dir; .tmp drained.
    expect((await readFile(join(root, slug), "utf8"))).toContain("not a magazine");
    const tmp = join(root, ".tmp");
    if (existsSync(tmp)) expect((await readdir(tmp)).length).toBe(0);
  });

  test("a post-assembly publish failure cleans the partial temp and publishes nothing", async () => {
    const root = await vault();
    const slug = "x-1";
    // Pre-create the target as a NON-EMPTY dir so the final rename() fails AFTER
    // the temp dir is fully assembled (image bytes + magazine.json + index.md +
    // manifest all written under .tmp) — i.e. a true mid-write/post-partial failure.
    await mkdir(join(root, slug), { recursive: true });
    await writeFile(join(root, slug, "sentinel.txt"), "preexisting");
    await expect(
      persistMagazine(plan(), { vaultRoot: root, fetchImpl: okFetch, now: "2026-06-01T00:00:00.000Z", slug }),
    ).rejects.toThrow();
    // Nothing of ours was published into the target; the partial temp was removed.
    expect(existsSync(join(root, slug, "magazine.json"))).toBe(false);
    expect(existsSync(join(root, slug, "sentinel.txt"))).toBe(true);
    const tmp = join(root, ".tmp");
    if (existsSync(tmp)) expect((await readdir(tmp)).length).toBe(0);
  });

  test("enforces the per-magazine asset byte budget (renders typographic)", async () => {
    const root = await vault();
    const res = await persistMagazine(plan(), {
      vaultRoot: root, fetchImpl: okFetch, now: "2026-06-01T00:00:00.000Z", maxMagazineBytes: 10,
    });
    const mag = JSON.parse(await readFile(join(res.dir, "magazine.json"), "utf8")) as Magazine;
    expect(mag.sections[0]!.images).toEqual([]); // image exceeded the 10-byte budget
  });
});

describe("persistMagazine — graph notes & path safety", () => {
  test("two magazines sharing a theme link the SAME theme note", async () => {
    const root = await vault();
    await persistMagazine(plan({ newsletter: "Alpha", themes: ["neuroscience"] }), {
      vaultRoot: root, fetchImpl: failFetch, now: "2026-06-01T00:00:00.000Z", slug: "alpha-2026-06-01",
    });
    await persistMagazine(plan({ newsletter: "Beta", themes: ["neuroscience"] }), {
      vaultRoot: root, fetchImpl: failFetch, now: "2026-06-02T00:00:00.000Z", slug: "beta-2026-06-02",
    });
    const themeNote = await readFile(join(root, "themes", "neuroscience.md"), "utf8");
    expect(themeNote).toContain("[[alpha-2026-06-01/index|Alpha]]");
    expect(themeNote).toContain("[[beta-2026-06-02/index|Beta]]");
  });

  test("reconcileNotes removes notes no longer referenced by any magazine", async () => {
    const root = await vault();
    const res = await persistMagazine(plan({ newsletter: "Solo", themes: ["ghost"] }), {
      vaultRoot: root, fetchImpl: failFetch, now: "2026-06-01T00:00:00.000Z", slug: "solo-2026-06-01",
    });
    expect(existsSync(join(root, "themes", "ghost.md"))).toBe(true);
    await rm(res.dir, { recursive: true, force: true }); // magazine gone
    await reconcileNotes(root);
    expect(existsSync(join(root, "themes", "ghost.md"))).toBe(false); // stale note pruned
  });

  test("sanitizes a hostile newsletter name and stays inside the vault", async () => {
    const root = await vault();
    const res = await persistMagazine(plan({ newsletter: "../../evil" }), {
      vaultRoot: root, fetchImpl: failFetch, now: "2026-06-01T00:00:00.000Z",
    });
    expect(res.dir.startsWith(root)).toBe(true);
    expect(res.slug).not.toContain("..");
    expect(res.slug).not.toContain("/");
  });
});
