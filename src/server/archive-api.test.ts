import { describe, expect, test } from "bun:test";
import { fetchArticle, fetchDeepArticles, isFreeArticle, listArchive } from "./archive-api.ts";

const ARCHIVE = JSON.stringify([
  { type: "newsletter", title: "Deep One", canonical_url: "https://p.example.com/p/deep-one", slug: "deep-one", post_date: "2026-06-01", audience: "everyone", wordcount: 1500 },
  { type: "newsletter", title: "Deep Two", canonical_url: "https://p.example.com/p/deep-two", slug: "deep-two", post_date: "2026-05-20", audience: "everyone", wordcount: 2000 },
  { type: "newsletter", title: "Paywalled", canonical_url: "https://p.example.com/p/paid", slug: "paid", post_date: "2026-05-10", audience: "only_paid", wordcount: 1800 },
  { type: "newsletter", title: "Short note", canonical_url: "https://p.example.com/p/note", slug: "note", post_date: "2026-05-05", audience: "everyone", wordcount: 120 },
  { type: "podcast", title: "A podcast", canonical_url: "https://p.example.com/p/pod", slug: "pod", post_date: "2026-05-01", audience: "everyone", wordcount: 900 },
]);

const postHtml = (title: string) =>
  `<html><body><article><div class="available-content"><div class="body markup">` +
  `<p>${title}: a real, substantial passage about meaning, attention, and the texture of inner life.</p>` +
  `<img src="https://cdn.example/img.jpg" alt="x"/></div></div></article></body></html>`;

function router(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/v1/archive")) {
      return new Response(url.includes("offset=0") ? ARCHIVE : "[]", { headers: { "content-type": "application/json" } });
    }
    const slug = url.split("/p/")[1] ?? "";
    return new Response(postHtml(slug), { headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
}

// Offline: fake domains don't resolve, so stub the SSRF host check as "public".
const opts = () => ({ fetchImpl: router(), resolveHost: async () => true });

describe("listArchive", () => {
  test("parses the archive list, skipping non-newsletter types", async () => {
    const items = await listArchive("p.example.com", { ...opts(), limit: 50 });
    expect(items.map((i) => i.title)).toEqual(["Deep One", "Deep Two", "Paywalled", "Short note"]); // podcast dropped
    expect(items[0]!.url).toBe("https://p.example.com/p/deep-one");
    expect(items[0]!.wordcount).toBe(1500);
    expect(items[2]!.audience).toBe("only_paid");
  });
});

describe("isFreeArticle", () => {
  test("free = everyone/only_free; paid is excluded", () => {
    expect(isFreeArticle({ audience: "everyone" } as never)).toBe(true);
    expect(isFreeArticle({ audience: "only_free" } as never)).toBe(true);
    expect(isFreeArticle({ audience: "only_paid" } as never)).toBe(false);
  });
});

describe("fetchArticle", () => {
  test("fetches the post page and extracts full inert content + images", async () => {
    const item = { title: "Deep One", url: "https://p.example.com/p/deep-one", slug: "deep-one", date: "2026-06-01", audience: "everyone", wordcount: 1500 };
    const post = await fetchArticle(item, opts());
    expect(post).not.toBeNull();
    expect(post!.postId).toBe(item.url); // canonical url is the stable id
    expect(post!.contentText).toContain("meaning, attention, and the texture of inner life");
    expect(post!.contentHtml).not.toContain("<script"); // body markup only
    expect(post!.images).toEqual(["https://cdn.example/img.jpg"]);
    expect(post!.source).toBe("archive");
  });
});

describe("fetchDeepArticles", () => {
  test("keeps free, long-enough articles and fetches their full content", async () => {
    const posts = await fetchDeepArticles("p.example.com", { ...opts(), limit: 50, minWordcount: 400 });
    // paid + short note + podcast all dropped -> only the two deep free articles
    expect(posts.map((p) => p.title)).toEqual(["Deep One", "Deep Two"]);
    expect(posts.every((p) => p.contentText.length > 0)).toBe(true);
    expect(posts.every((p) => p.postId === p.url)).toBe(true);
  });
});

describe("SSRF + same-publication guard", () => {
  test("fetchArticle rejects a private-IP host (returns null), never fetching it", async () => {
    let fetched = false;
    const fetchImpl = (async () => { fetched = true; return new Response("x"); }) as unknown as typeof fetch;
    const item = { title: "Evil", url: "http://127.0.0.1/p/evil", slug: "evil", date: null, audience: "everyone", wordcount: 1500 };
    expect(await fetchArticle(item, { fetchImpl })).toBeNull(); // 127.0.0.1 is a private IP literal
    expect(fetched).toBe(false);
  });

  test("fetchDeepArticles drops canonical_urls that aren't on the publication's domain", async () => {
    const archive = JSON.stringify([
      { type: "newsletter", title: "Onsite", canonical_url: "https://p.example.com/p/onsite", audience: "everyone", wordcount: 1500 },
      { type: "newsletter", title: "Offsite", canonical_url: "https://evil.example.org/p/offsite", audience: "everyone", wordcount: 1500 },
    ]);
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/v1/archive")) {
        return new Response(url.includes("offset=0") ? archive : "[]", { headers: { "content-type": "application/json" } });
      }
      return new Response(postHtml(url.split("/p/")[1] ?? ""), { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const posts = await fetchDeepArticles("p.example.com", { fetchImpl, resolveHost: async () => true });
    expect(posts.map((p) => p.title)).toEqual(["Onsite"]); // the off-domain article is dropped
  });
});
