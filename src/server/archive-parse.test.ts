import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { archiveRefToPost, parseArchive } from "./archive-parse.ts";

const FIX = join(import.meta.dir, "../../fixtures");
const archiveHtml = readFileSync(join(FIX, "archive.html"), "utf8");
const emptyHtml = readFileSync(join(FIX, "archive-empty.html"), "utf8");
const BASE = "https://daily-curio.substack.com/archive";

describe("parseArchive", () => {
  test("extracts only /p/ post links as absolute URLs, deduped", () => {
    const refs = parseArchive(archiveHtml, BASE).map((r) => r.url).toSorted();
    expect(refs).toEqual([
      "https://daily-curio.substack.com/p/cloud-cartographers",
      "https://daily-curio.substack.com/p/glass-armonica",
      "https://daily-curio.substack.com/p/the-emperors-clockmaker",
    ]);
  });

  test("excludes non-post and external links", () => {
    const urls = parseArchive(archiveHtml, BASE).map((r) => r.url);
    expect(urls.some((u) => u.includes("/about"))).toBe(false);
    expect(urls.some((u) => u.includes("twitter.com"))).toBe(false);
  });

  test("normalizes titles", () => {
    const ref = parseArchive(archiveHtml, BASE).find((r) => r.url.endsWith("glass-armonica"));
    expect(ref?.title).toBe("Franklin's glass armonica"); // curly apostrophe folded
  });

  test("returns [] for empty/client-rendered archives (no throw)", () => {
    expect(parseArchive(emptyHtml, BASE)).toEqual([]);
    expect(parseArchive("", BASE)).toEqual([]);
  });
});

describe("archiveRefToPost", () => {
  test("builds a source=archive post with empty body", () => {
    const post = archiveRefToPost({ title: "T", url: "https://x.substack.com/p/y" });
    expect(post.source).toBe("archive");
    expect(post.contentText).toBe("");
    expect(post.postId).toBe("https://x.substack.com/p/y");
  });
});
