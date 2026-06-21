/**
 * Pure, best-effort archive parsing (PLAN.md MG3). Substack `/archive` lists
 * posts as links to `/p/<slug>`. We extract those refs (title + url) to surface
 * older "greatest-hits" posts. Returns [] on empty/garbage HTML — never throws,
 * so the fetcher can fall back to RSS-only.
 */
import { parse as parseHtml } from "node-html-parser";
import { normalize } from "../shared/text.ts";
import type { Post } from "../shared/post.ts";

export interface ArchiveRef {
  title: string;
  url: string;
}

export function parseArchive(html: string, baseUrl: string): ArchiveRef[] {
  if (!html) return [];
  let root;
  try {
    root = parseHtml(html);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: ArchiveRef[] = [];
  for (const anchor of root.querySelectorAll("a")) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    let abs: URL;
    try {
      abs = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (!/\/p\/[^/]+/.test(abs.pathname)) continue;
    const clean = `${abs.origin}${abs.pathname}`;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ title: normalize(anchor.text) || "Untitled", url: clean });
  }
  return out;
}

/** Turn an archive ref (no body content available) into a Post. */
export function archiveRefToPost(ref: ArchiveRef): Post {
  return {
    postId: ref.url,
    title: ref.title,
    url: ref.url,
    date: null,
    contentHtml: "",
    contentText: "",
    images: [],
    locked: false,
    source: "archive",
  };
}
