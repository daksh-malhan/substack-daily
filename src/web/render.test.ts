import { describe, expect, test } from "bun:test";
import type { Magazine } from "../shared/magazine.ts";
import {
  assetUrl,
  escapeHtml,
  type LibrarySummary,
  magazineHostAttrs,
  renderLibraryList,
  renderMagazineHTML,
  safeHttpUrl,
  safeLocalImageSrc,
} from "./render.ts";
import { DEFAULT_ACCENT, DEFAULT_VIBE, resolveVibePresetId, safeAccent, vibeClass, VIBE_PRESET_IDS } from "./vibe.ts";

function mag(over: Partial<Magazine> = {}): Magazine {
  return {
    id: "daily-curio-2026-06-01",
    newsletter: "Daily Curio",
    newsletterUrl: "https://daily-curio.substack.com",
    title: "A Field Guide to Curios",
    intro: "Weird and wonderful knowledge.",
    themes: ["history", "nature"],
    vibePresetId: "vintage-science",
    accentColor: "#8a3b2f",
    generatedAt: "2026-06-01T00:00:00.000Z",
    sections: [
      {
        heading: "Dyes",
        prose: "A note on color.",
        excerpts: [{ text: "ten thousand sea snails", sourceUrl: "https://daily-curio.substack.com/p/tyrian-purple", sourceTitle: "Tyrian purple" }],
        images: [{ src: "images/abc123.png", alt: "a dyed robe" }],
      },
    ],
    ...over,
  };
}

describe("vibe", () => {
  test("every known preset maps to its own class; unknown falls back to default", () => {
    for (const id of VIBE_PRESET_IDS) expect(vibeClass(id)).toBe(`vibe-${id}`);
    expect(resolveVibePresetId("not-a-real-preset")).toBe(DEFAULT_VIBE);
    expect(vibeClass("not-a-real-preset")).toBe(`vibe-${DEFAULT_VIBE}`);
  });
  test("accent is validated; a bad value cannot inject CSS", () => {
    expect(safeAccent("#8a3b2f")).toBe("#8a3b2f");
    expect(safeAccent("red; } body { display:none")).toBe(DEFAULT_ACCENT);
    expect(safeAccent("#xyz")).toBe(DEFAULT_ACCENT);
  });
});

describe("escaping & URL safety", () => {
  test("escapeHtml neutralizes angle brackets, quotes, ampersands", () => {
    expect(escapeHtml(`<script>"&'`)).toBe("&lt;script&gt;&quot;&amp;&#39;");
  });
  test("safeHttpUrl allows http(s), rejects javascript: and garbage", () => {
    expect(safeHttpUrl("https://x.substack.com/p/1")).toBe("https://x.substack.com/p/1");
    expect(safeHttpUrl("javascript:alert(1)")).toBe("#");
    expect(safeHttpUrl("not a url")).toBe("#");
  });
  test("safeLocalImageSrc accepts in-folder paths, rejects remote/abs/traversal", () => {
    expect(safeLocalImageSrc("images/a.png")).toBe("images/a.png");
    expect(safeLocalImageSrc("images/0aF9-_.webp")).toBe("images/0aF9-_.webp");
    expect(safeLocalImageSrc("/etc/passwd")).toBeNull();
    expect(safeLocalImageSrc("https://evil/x.png")).toBeNull();
    expect(safeLocalImageSrc("data:image/png;base64,AAAA")).toBeNull();
    expect(safeLocalImageSrc("images/../../secret")).toBeNull();
  });
  test("assetUrl routes images through the same-origin /library-assets/:id route", () => {
    expect(assetUrl("daily-curio-2026-06-01", "images/abc.png")).toBe("/library-assets/daily-curio-2026-06-01/images/abc.png");
    expect(assetUrl("bad id!", "images/abc.png")).toBeNull(); // id not a clean slug
    expect(assetUrl("ok-id", "https://evil/x.png")).toBeNull(); // remote src dropped
    expect(assetUrl("ok-id", "images/../secret")).toBeNull(); // traversal dropped
  });

  test("safeLocalImageSrc resists browser-normalization bypasses", () => {
    expect(safeLocalImageSrc(" https://evil/x.png")).toBeNull(); // leading space browsers trim
    expect(safeLocalImageSrc("https://evil/x.png ")).toBeNull(); // trailing space
    expect(safeLocalImageSrc("ima\tges/a.png")).toBeNull(); // embedded tab
    expect(safeLocalImageSrc("img\nages/a.png")).toBeNull(); // embedded newline
    expect(safeLocalImageSrc("//evil/x.png")).toBeNull(); // protocol-relative
    expect(safeLocalImageSrc("%2e%2e/secret.png")).toBeNull(); // percent-encoded traversal
    expect(safeLocalImageSrc("images/%2e%2e/x.png")).toBeNull(); // percent-encoded mid-path
    expect(safeLocalImageSrc("images//x.png")).toBeNull(); // empty segment
  });
});

describe("magazineHostAttrs", () => {
  test("derives the preset class + validated accent", () => {
    const attrs = magazineHostAttrs(mag());
    expect(attrs.className).toBe("magazine vibe-vintage-science");
    expect(attrs.accent).toBe("#8a3b2f");
    expect(attrs.preset).toBe("vintage-science");
  });
  test("an unknown preset/accent degrades to defaults", () => {
    const attrs = magazineHostAttrs(mag({ vibePresetId: "bogus", accentColor: "evil" }));
    expect(attrs.className).toBe(`magazine vibe-${DEFAULT_VIBE}`);
    expect(attrs.accent).toBe(DEFAULT_ACCENT);
  });
});

describe("renderMagazineHTML", () => {
  test("renders masthead, themes, intro, sections, prose, excerpts, figure, footer", () => {
    const html = renderMagazineHTML(mag());
    expect(html).toContain(`<h1 class="mag-title">A Field Guide to Curios</h1>`);
    expect(html).toContain(`<li class="mag-theme">history</li>`);
    expect(html).toContain(`<p class="mag-intro">Weird and wonderful knowledge.</p>`);
    expect(html).toContain(`<h2 class="mag-heading">Dyes</h2>`);
    expect(html).toContain(`<p class="mag-prose">A note on color.</p>`);
    expect(html).toContain("ten thousand sea snails");
    expect(html).toContain(`<img class="mag-image" src="/library-assets/daily-curio-2026-06-01/images/abc123.png"`);
    expect(html).toContain("vibe: vintage-science");
  });

  test("network guard: every image URL is a same-origin /library-assets path (no remote)", () => {
    const html = renderMagazineHTML(mag());
    const srcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]!);
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) {
      expect(src.startsWith("/library-assets/")).toBe(true);
      expect(/^[a-z]+:/i.test(src)).toBe(false); // no scheme (http/https/data)
    }
  });

  test("source links open in a new tab with noopener", () => {
    const html = renderMagazineHTML(mag());
    expect(html).toContain(`href="https://daily-curio.substack.com/p/tyrian-purple"`);
    expect(html).toContain(`target="_blank"`);
    expect(html).toContain(`rel="noopener noreferrer"`);
  });

  test("XSS in any field is escaped, never executed", () => {
    const html = renderMagazineHTML(
      mag({
        title: `<img src=x onerror=alert(1)>`,
        intro: `</p><script>alert(2)</script>`,
        themes: [`<b>theme</b>`],
        sections: [{
          heading: `<svg onload=alert(3)>`,
          prose: `pro<se`,
          excerpts: [{ text: `"><script>alert(4)</script>`, sourceUrl: "javascript:alert(5)", sourceTitle: `<x>` }],
          images: [],
        }],
      }),
    );
    // No executable tags survive — every "<" became "&lt;", so these are inert text.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x onerror");
    expect(html).not.toContain("<svg onload");
    expect(html).toContain("&lt;script&gt;");
    // a javascript: source url is neutralized to an inert cite (no live link)
    expect(html).not.toContain('href="javascript:alert(5)"');
  });

  test("renderLibraryList: cards carry data-id for open/delete; empty state when none; XSS escaped", () => {
    expect(renderLibraryList([])).toContain("No saved magazines");
    const entries: LibrarySummary[] = [
      { id: "alpha-2026-06-01", title: `<b>Alpha</b>`, newsletter: "Daily Curio", themes: ["history"], vibePresetId: "zine", accentColor: "#8a3b2f", generatedAt: "2026-06-01T00:00:00.000Z" },
    ];
    const html = renderLibraryList(entries);
    expect(html).toContain(`class="lib-open" data-id="alpha-2026-06-01"`);
    expect(html).toContain(`class="lib-delete" data-id="alpha-2026-06-01"`);
    expect(html).toContain("Daily Curio · 2026-06-01");
    expect(html).not.toContain("<b>Alpha</b>"); // title escaped
    expect(html).toContain("&lt;b&gt;Alpha&lt;/b&gt;");
  });

  test("a remote/absolute image src is dropped (offline-safe)", () => {
    const html = renderMagazineHTML(
      mag({ sections: [{ heading: "H", prose: "", excerpts: [], images: [{ src: "https://evil/x.png", alt: "x" }] }] }),
    );
    expect(html).not.toContain("evil");
    expect(html).not.toContain("<img");
  });
});
