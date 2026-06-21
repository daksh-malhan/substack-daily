/**
 * Pure RSS-feed parsing (PLAN.md MG3). No network — takes XML text, returns
 * posts. Every post carries an inert, normalized `contentText` (the only thing
 * MG4 sends to Codex) alongside the raw `contentHtml` (used for image extraction).
 */
import { XMLParser } from "fast-xml-parser";
import { parse as parseHtml } from "node-html-parser";
import { normalize, toPlainText } from "../shared/text.ts";
import type { Post } from "../shared/post.ts";

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: true,
  htmlEntities: true,
});

// Substack teaser markers for paywalled posts (matched against inert text).
const LOCKED_RE =
  /this post is for paid subscribers|paid subscribers only|subscribe to (keep reading|read)|upgrade to paid|become a paid subscriber/i;

export interface ParsedFeed {
  title: string;
  generator: string;
  link: string;
  posts: Post[];
}

type XmlNode = unknown;

function text(node: XmlNode): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (typeof node === "object" && node !== null && "#text" in node) {
    const t = (node as Record<string, unknown>)["#text"];
    return t == null ? "" : String(t);
  }
  return "";
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function extractImages(html: string, baseUrl: string): string[] {
  if (!html) return [];
  const root = parseHtml(html);
  const seen = new Set<string>();
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src) continue;
    try {
      const abs = baseUrl ? new URL(src, baseUrl).href : new URL(src).href;
      if (abs.startsWith("http")) seen.add(abs);
    } catch {
      // ignore unparseable src
    }
  }
  return [...seen];
}

function resolveUrl(href: string, base: string | undefined): string {
  if (!href) return "";
  try {
    return base ? new URL(href, base).href : new URL(href).href;
  } catch {
    return href;
  }
}

/** Parse RSS. `baseUrl` (the final feed URL) resolves any relative item links. */
export function parseRssFeed(xmlText: string, baseUrl?: string): ParsedFeed {
  const doc = xml.parse(xmlText) as Record<string, unknown>;
  const rss = doc["rss"] as Record<string, unknown> | undefined;
  const channel = rss?.["channel"] as Record<string, unknown> | undefined;
  if (!channel) throw new Error("not an RSS feed (no rss>channel)");

  const title = text(channel["title"]) || "Untitled";
  const generator = text(channel["generator"]);
  const link =
    typeof channel["link"] === "string" ? (channel["link"] as string) : text(channel["link"]);

  const posts: Post[] = asArray(channel["item"] as unknown).map((raw, i): Post => {
    const item = raw as Record<string, unknown>;
    const url = resolveUrl(text(item["link"]), baseUrl ?? link);
    const contentHtml = text(item["content:encoded"]) || text(item["description"]) || "";
    const contentText = normalize(toPlainText(contentHtml));
    const guid = item["guid"] != null ? text(item["guid"]) : "";
    const pub = text(item["pubDate"]);
    let date: string | null = null;
    if (pub) {
      const d = new Date(pub);
      if (!Number.isNaN(d.getTime())) date = d.toISOString();
    }
    return {
      postId: guid || url || `item-${i}`,
      title: text(item["title"]) || "Untitled",
      url,
      date,
      contentHtml,
      contentText,
      images: extractImages(contentHtml, url),
      locked: LOCKED_RE.test(contentText),
      source: "rss",
    };
  });

  return { title, generator, link, posts };
}

/** Verify the parsed feed is actually a Substack publication. */
export function isSubstackFeed(feed: ParsedFeed, finalUrl: string): boolean {
  if (/substack/i.test(feed.generator)) return true;
  for (const candidate of [feed.link, finalUrl]) {
    try {
      if (new URL(candidate).hostname.endsWith("substack.com")) return true;
    } catch {
      // ignore
    }
  }
  return false;
}
