import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchPublication } from "./fetcher.ts";

const FIX = join(import.meta.dir, "../../fixtures");
const feedXml = readFileSync(join(FIX, "feed.xml"), "utf8");
const nonsubXml = readFileSync(join(FIX, "feed-nonsubstack.xml"), "utf8");
const archiveHtml = readFileSync(join(FIX, "archive.html"), "utf8");
const archiveEmptyHtml = readFileSync(join(FIX, "archive-empty.html"), "utf8");

type Handler = (url: string) => Response | Promise<Response>;

function mockFetch(routes: Record<string, Handler>): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const handler = routes[url];
    if (!handler) return new Response("not found", { status: 404 });
    return handler(url);
  }) as typeof fetch;
}

const opts = (routes: Record<string, Handler>) => ({ fetchImpl: mockFetch(routes), retries: 0 });

describe("fetchPublication — happy path with archive merge", () => {
  test("returns RSS posts plus deduped archive posts", async () => {
    const res = await fetchPublication(
      "daily-curio.substack.com",
      opts({
        "https://daily-curio.substack.com/feed": () => new Response(feedXml, { status: 200 }),
        "https://daily-curio.substack.com/archive": () => new Response(archiveHtml, { status: 200 }),
      }),
    );
    expect(res.newsletter).toBe("Daily Curio");
    expect(res.domain).toBe("daily-curio.substack.com");
    // 12 RSS + 2 new archive (cloud-cartographers dedups against post-0001).
    expect(res.posts.length).toBe(14);
    expect(res.posts.length).toBeGreaterThanOrEqual(10);
    expect(res.archiveOk).toBe(true);
    expect(res.posts.filter((p) => p.locked).length).toBe(1);
    expect(res.posts.filter((p) => p.source === "archive").length).toBe(2);
    for (const p of res.posts) expect(p.postId.length).toBeGreaterThan(0);
  });
});

describe("fetchPublication — domain resolution", () => {
  test("accepts a custom domain (Substack via generator)", async () => {
    const res = await fetchPublication(
      "custom-curio.example.com",
      opts({
        "https://custom-curio.example.com/feed": () => new Response(feedXml, { status: 200 }),
      }),
    );
    expect(res.posts.length).toBe(12);
    expect(res.archiveOk).toBe(false);
  });

  test("follows a redirect to the canonical subdomain", async () => {
    const res = await fetchPublication(
      "old-curio.example.com",
      opts({
        "https://old-curio.example.com/feed": () =>
          new Response(null, { status: 301, headers: { location: "https://new-curio.substack.com/feed" } }),
        "https://new-curio.substack.com/feed": () => new Response(feedXml, { status: 200 }),
      }),
    );
    expect(res.feedUrl).toBe("https://new-curio.substack.com/feed");
    expect(res.domain).toBe("new-curio.substack.com"); // resolved host, not the input
    expect(res.posts.length).toBe(12);
  });
});

describe("fetchPublication — structured errors", () => {
  test("rejects an invalid domain", async () => {
    await expect(fetchPublication("not a domain", opts({}))).rejects.toThrow(/invalid domain/i);
  });

  test("rejects a non-Substack feed", async () => {
    await expect(
      fetchPublication(
        "example.com",
        opts({ "https://example.com/feed": () => new Response(nonsubXml, { status: 200 }) }),
      ),
    ).rejects.toThrow(/not a Substack feed/i);
  });

  test("rejects a blocked / 5xx feed", async () => {
    await expect(
      fetchPublication(
        "blocked.example.com",
        opts({ "https://blocked.example.com/feed": () => new Response("nope", { status: 503 }) }),
      ),
    ).rejects.toThrow(/HTTP 503/);
  });

  test("rejects a non-feed response", async () => {
    await expect(
      fetchPublication(
        "weird.substack.com",
        opts({ "https://weird.substack.com/feed": () => new Response("<html>nope</html>", { status: 200 }) }),
      ),
    ).rejects.toThrow(/not an RSS feed/i);
  });
});

describe("fetchPublication — archive is best-effort", () => {
  test("archive fetch that throws falls back to RSS-only (no throw)", async () => {
    const res = await fetchPublication("daily-curio.substack.com", {
      retries: 0,
      fetchImpl: mockFetch({
        "https://daily-curio.substack.com/feed": () => new Response(feedXml, { status: 200 }),
        "https://daily-curio.substack.com/archive": () => {
          throw new Error("archive boom");
        },
      }),
    });
    expect(res.posts.length).toBe(12);
    expect(res.archiveOk).toBe(false);
  });

  test("empty/client-rendered archive yields RSS-only", async () => {
    const res = await fetchPublication(
      "daily-curio.substack.com",
      opts({
        "https://daily-curio.substack.com/feed": () => new Response(feedXml, { status: 200 }),
        "https://daily-curio.substack.com/archive": () => new Response(archiveEmptyHtml, { status: 200 }),
      }),
    );
    expect(res.posts.length).toBe(12);
    expect(res.archiveOk).toBe(false);
  });
});
