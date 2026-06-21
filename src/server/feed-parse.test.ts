import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSubstackFeed, parseRssFeed } from "./feed-parse.ts";

const FIX = join(import.meta.dir, "../../fixtures");
const feedXml = readFileSync(join(FIX, "feed.xml"), "utf8");
const nonsubXml = readFileSync(join(FIX, "feed-nonsubstack.xml"), "utf8");

describe("parseRssFeed", () => {
  const feed = parseRssFeed(feedXml);

  test("reads channel metadata", () => {
    expect(feed.title).toBe("Daily Curio");
    expect(feed.generator).toMatch(/substack/i);
  });

  test("parses all items with required fields", () => {
    expect(feed.posts.length).toBe(12);
    for (const p of feed.posts) {
      expect(p.postId).toBeString();
      expect(p.postId.length).toBeGreaterThan(0);
      expect(p.url).toStartWith("https://daily-curio.substack.com/p/");
      expect(p.title.length).toBeGreaterThan(0);
      expect(typeof p.contentText).toBe("string");
      expect(p.source).toBe("rss");
    }
  });

  test("uses guid as the stable postId", () => {
    expect(feed.posts[0]!.postId).toBe("post-0001");
  });

  test("normalizes contentText (entities + smart quotes folded to ascii)", () => {
    // Source has &ldquo;coastlines&rdquo; -> decoded curly quotes -> folded to ".
    expect(feed.posts[0]!.contentText).toContain('"coastlines"');
    expect(feed.posts[0]!.contentText).not.toContain("“"); // no left double quote
  });

  test("extracts absolute image URLs", () => {
    expect(feed.posts[0]!.images).toContain("https://substackcdn.com/image/cloud.jpg");
    expect(feed.posts[2]!.images).toEqual([]); // tyrian purple has no <img>
  });

  test("parses pubDate to ISO", () => {
    expect(feed.posts[0]!.date).toBe("2026-06-02T09:00:00.000Z");
  });

  test("flags the paywalled post as locked, others not", () => {
    const locked = feed.posts.filter((p) => p.locked);
    expect(locked.length).toBe(1);
    expect(locked[0]!.url).toContain("snowflake-math");
  });

  test("resolves relative item links against the base URL", () => {
    const rel =
      `<?xml version="1.0"?><rss version="2.0"><channel><title>X</title>` +
      `<link>https://x.substack.com</link>` +
      `<item><title>P</title><link>/p/rel-post</link><guid>g1</guid></item></channel></rss>`;
    const relFeed = parseRssFeed(rel, "https://x.substack.com/feed");
    expect(relFeed.posts[0]!.url).toBe("https://x.substack.com/p/rel-post");
  });

  test("throws on non-RSS input", () => {
    expect(() => parseRssFeed("<html><body>nope</body></html>")).toThrow();
  });
});

describe("isSubstackFeed", () => {
  test("true via Substack generator", () => {
    expect(isSubstackFeed(parseRssFeed(feedXml), "https://daily-curio.substack.com/feed")).toBe(true);
  });
  test("true via a *.substack.com final URL even without a generator", () => {
    const feed = { title: "x", generator: "", link: "https://x.example.com", posts: [] };
    expect(isSubstackFeed(feed, "https://x.substack.com/feed")).toBe(true);
  });
  test("false for a non-Substack feed", () => {
    expect(isSubstackFeed(parseRssFeed(nonsubXml), "https://example.com/feed")).toBe(false);
  });
});
