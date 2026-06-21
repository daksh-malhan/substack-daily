import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Post } from "../shared/post.ts";
import {
  acquireImages,
  cseImageSearch,
  harvestPostImages,
  substackWidthFromUrl,
  urlLooksLikeIcon,
} from "./images.ts";
import type { SynthesisResult, SynthSection } from "./synth.ts";

const cseFixture = readFileSync(join(import.meta.dir, "../../fixtures/cse-response.json"), "utf8");

function post(id: string, images: string[]): Post {
  return {
    postId: id,
    title: `Title ${id}`,
    url: `https://x.substack.com/p/${id}`,
    date: null,
    contentHtml: "",
    contentText: "",
    images,
    locked: false,
    source: "rss",
  };
}

function section(postId: string): SynthSection {
  return {
    heading: `H ${postId}`,
    prose: "p",
    excerpts: [{ text: "t", sourceUrl: "u", sourceTitle: "s", postId }],
  };
}

function synthOf(sections: SynthSection[], imageQueries: string[] = ["q1", "q2"]): SynthesisResult {
  return {
    newsletter: "N",
    domain: "x.substack.com",
    intro: "i",
    themes: [],
    vibePresetId: "zine",
    accentColor: "#000000",
    imageQueries,
    sections,
  };
}

const cseFetch = (async () => new Response(cseFixture, { status: 200 })) as unknown as typeof fetch;

describe("filters", () => {
  test("urlLooksLikeIcon flags non-content images", () => {
    expect(urlLooksLikeIcon("https://x/avatar/me.png")).toBe(true);
    expect(urlLooksLikeIcon("https://x/assets/site-logo.png")).toBe(true);
    expect(urlLooksLikeIcon("https://x/favicon.ico")).toBe(true);
    expect(urlLooksLikeIcon("https://x/tracking-pixel.gif")).toBe(true);
    expect(urlLooksLikeIcon("https://x/photos/cloud.jpg")).toBe(false);
  });

  test("substackWidthFromUrl extracts the resized width", () => {
    expect(substackWidthFromUrl("https://substackcdn.com/image/w_1456,c_limit/cloud.jpg")).toBe(1456);
    expect(substackWidthFromUrl("https://x/cloud.jpg")).toBeNull();
  });
});

describe("harvestPostImages", () => {
  test("keeps content images, drops icons/small, dedupes, keys by post", () => {
    const cloud = "https://substackcdn.com/image/w_1456,c_limit/cloud.jpg";
    const posts = [
      post("p1", [cloud]),
      post("p2", ["https://substackcdn.com/image/w_36,c_limit/avatar.jpg"]), // small + 'avatar'
      post("p3", []),
      post("p4", [cloud]), // exact duplicate of p1's image
    ];
    const byPost = harvestPostImages(posts);
    expect(byPost.get("p1")?.length).toBe(1);
    expect(byPost.has("p2")).toBe(false);
    expect(byPost.has("p3")).toBe(false);
    expect(byPost.has("p4")).toBe(false); // duplicate URL deduped away

    const total = [...byPost.values()].reduce((n, list) => n + list.length, 0);
    expect(total).toBe(1); // the shared URL appears exactly once across all posts
  });
});

describe("cseImageSearch", () => {
  test("returns candidates, filtering tiny and icon results", async () => {
    const got = await cseImageSearch("vintage cartography", { key: "k", cx: "c", fetchImpl: cseFetch });
    const urls = got.map((c) => c.url);
    expect(urls).toContain("https://img.example.com/cartography-big.jpg");
    expect(urls).toContain("https://img.example.com/portrait.jpg");
    expect(urls).not.toContain("https://img.example.com/tiny-thumb.jpg"); // 80x60 too small
    expect(urls).not.toContain("https://img.example.com/assets/site-logo.png"); // logo
    expect(got.every((c) => c.source === "cse")).toBe(true);
  });

  test("returns [] on a non-ok response", async () => {
    const bad = (async () => new Response("quota", { status: 429 })) as unknown as typeof fetch;
    expect(await cseImageSearch("q", { key: "k", cx: "c", fetchImpl: bad })).toEqual([]);
  });

  test("returns [] when fetch throws", async () => {
    const boom = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await cseImageSearch("q", { key: "k", cx: "c", fetchImpl: boom })).toEqual([]);
  });
});

describe("acquireImages", () => {
  test("uses a section's own post image when available", async () => {
    const posts = [post("p1", ["https://substackcdn.com/image/w_1456,c_limit/cloud.jpg"])];
    const plan = await acquireImages(synthOf([section("p1")]), posts, {});
    expect(plan.sections[0]!.image).toEqual({
      kind: "image",
      candidate: expect.objectContaining({ source: "post", url: expect.stringContaining("cloud.jpg") }),
    });
  });

  test("falls back to a CSE vibe image for sections without post images", async () => {
    const posts = [post("p3", [])];
    const plan = await acquireImages(synthOf([section("p3")]), posts, {
      googleKey: "k",
      googleCseId: "c",
      fetchImpl: cseFetch,
    });
    expect(plan.usedCse).toBe(true);
    expect(plan.sections[0]!.image).toMatchObject({ kind: "image", candidate: { source: "cse" } });
  });

  test("degrades to post-only with a warning when no Google key, and never leaves a section without a plan", async () => {
    const posts = [
      post("p1", ["https://substackcdn.com/image/w_1456,c_limit/cloud.jpg"]),
      post("p3", []),
    ];
    const warnings: string[] = [];
    const plan = await acquireImages(synthOf([section("p1"), section("p3")]), posts, {
      warn: (m) => warnings.push(m),
    });
    expect(warnings.some((w) => /GOOGLE_CSE/.test(w))).toBe(true);
    expect(plan.usedCse).toBe(false);
    expect(plan.sections[0]!.image.kind).toBe("image"); // p1 has an image
    expect(plan.sections[1]!.image.kind).toBe("typographic"); // p3 has none, no CSE
    for (const s of plan.sections) expect(s.image).toBeDefined();
  });
});
