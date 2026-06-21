/**
 * Substack archive API client (MG13 — deep-dive brainfood pipeline, phase 1).
 *
 * The RSS feed only carries the ~20 most-recent posts; to scan a publication's
 * archive ~50 deep we use Substack's archive API:
 *   GET https://<domain>/api/v1/archive?sort=new&limit=12&offset=N
 * which returns a JSON list of posts (canonical_url, title, audience, wordcount,
 * post_date, slug) — but NOT the full body. We keep only FREE posts
 * (audience === "everyone", whose full text is public), pre-filter by wordcount,
 * then fetch each post's page and extract the article body to inert text.
 *
 * Like the rest of the pipeline this takes an injected `fetchImpl` so it's
 * testable offline, follows redirects (some pubs moved off *.substack.com), and
 * only ever produces inert `Post.contentText` (never raw HTML to Codex).
 */
import { parse } from "node-html-parser";
import { canonicalizeDomain } from "../shared/domains.ts";
import type { Post } from "../shared/post.ts";
import { toPlainText } from "../shared/text.ts";
import { FetchError, type FetchOpts, fetchWithRedirects } from "./http.ts";
import { hostIsPublic } from "./image-download.ts";

const ARCHIVE_PAGE = 12; // Substack's archive page size
const DEFAULT_LIMIT = 50;
const MIN_WORDCOUNT = 400; // cheap depth pre-filter: skip notes/short link posts
const READ_TIMEOUT_MS = 20_000; // cap the body read so a slow/hanging page can't stall the run
const MAX_ARTICLE_BYTES = 6 * 1024 * 1024; // cap body size so a giant page can't blow up memory
const FETCH_BUDGET_MS = 4 * 60 * 1000; // bound the whole fetch stage (many sequential page loads)

/**
 * Read a response body as text under TWO hard bounds: never buffer more than
 * `maxBytes` (the cap is checked BEFORE appending, so it's strict), and never
 * read longer than `timeoutMs` (a per-read race). On either bound — and on
 * normal completion — the reader is CANCELLED in `finally`, so a slow/hostile
 * page can't keep streaming into an abandoned read.
 */
async function readCappedText(res: Response, maxBytes: number, timeoutMs: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let out = "";
  let total = 0;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break; // read timeout — stop (reader cancelled in finally)
      const step = await Promise.race([
        reader.read(),
        new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
      ]);
      if ("timeout" in step) break;
      if (step.done) break;
      if (step.value) {
        if (total + step.value.length > maxBytes) break; // strict cap — never buffer past it
        total += step.value.length;
        out += decoder.decode(step.value, { stream: true });
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}

/** archive URLs come from publication-controlled API responses, so SSRF-guard them. */
export type ArchiveOpts = FetchOpts & {
  limit?: number;
  minWordcount?: number;
  /** DNS resolver override (tests inject one; production uses real DNS). */
  resolveHost?: (host: string) => Promise<boolean>;
};

/**
 * Reject non-http(s) and any host that is (or resolves to) a private/loopback IP.
 * If `expectedDomain` is given, also reject hosts off that publication — so an
 * article can't redirect us into ingesting some other site's content.
 */
async function assertSafeUrl(
  url: string,
  resolveHost?: (host: string) => Promise<boolean>,
  expectedDomain?: string,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FetchError("bad url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new FetchError("non-http url");
  if (!(await hostIsPublic(parsed.hostname, resolveHost))) throw new FetchError("ssrf: non-public host");
  if (expectedDomain && canonicalizeDomain(parsed.hostname) !== expectedDomain) {
    throw new FetchError("off-publication redirect rejected");
  }
}

/** True if `url`'s host belongs to the same publication as `canonicalDomain`. */
function samePublication(url: string, canonicalDomain: string): boolean {
  try {
    return canonicalizeDomain(new URL(url).hostname) === canonicalDomain;
  } catch {
    return false;
  }
}

export interface ArchiveItem {
  title: string;
  url: string; // canonical_url
  slug: string;
  date: string | null;
  audience: string; // "everyone" (free) | "only_paid" | "only_free" | ...
  wordcount: number;
}

interface RawArchivePost {
  title?: string;
  canonical_url?: string;
  slug?: string;
  post_date?: string;
  audience?: string;
  wordcount?: number;
  type?: string;
}

/** True for a post whose full text is publicly readable (free). */
export function isFreeArticle(item: ArchiveItem): boolean {
  return item.audience === "everyone" || item.audience === "only_free";
}

function archiveUrl(domain: string, offset: number): string {
  return `https://${domain}/api/v1/archive?sort=new&limit=${ARCHIVE_PAGE}&offset=${offset}`;
}

/** List up to `limit` recent posts from a publication's archive (paginated). */
export async function listArchive(domain: string, opts: ArchiveOpts = {}): Promise<ArchiveItem[]> {
  const canonical = canonicalizeDomain(domain);
  if (!canonical) return [];
  const limit = opts.limit ?? DEFAULT_LIMIT;
  // The archive API may redirect across the publication's own hosts (e.g.
  // *.substack.com -> custom domain), so only the public-host guard here.
  const guarded = { ...opts, validateUrl: (u: string) => assertSafeUrl(u, opts.resolveHost) };

  const items: ArchiveItem[] = [];
  for (let offset = 0; offset < limit; offset += ARCHIVE_PAGE) {
    let page: RawArchivePost[];
    try {
      const { res } = await fetchWithRedirects(archiveUrl(canonical, offset), guarded);
      if (!res.ok) break;
      const text = await readCappedText(res, MAX_ARTICLE_BYTES, opts.timeoutMs ?? READ_TIMEOUT_MS);
      const json = JSON.parse(text) as unknown;
      if (!Array.isArray(json)) break;
      page = json as RawArchivePost[];
    } catch {
      break; // network/parse failure -> stop paginating, return what we have
    }
    if (page.length === 0) break;
    for (const p of page) {
      if (p.type && p.type !== "newsletter") continue; // skip podcasts/threads/notes
      if (!p.canonical_url || !p.title) continue;
      items.push({
        title: p.title,
        url: p.canonical_url,
        slug: p.slug ?? "",
        date: p.post_date ?? null,
        audience: p.audience ?? "",
        wordcount: typeof p.wordcount === "number" ? p.wordcount : 0,
      });
    }
    if (page.length < ARCHIVE_PAGE) break; // last page
  }
  return items.slice(0, limit);
}

/** Substack post body lives in `.available-content .body.markup`; fall back gracefully. */
function extractArticle(html: string): { contentHtml: string; contentText: string; images: string[] } {
  const root = parse(html);
  const body =
    root.querySelector(".available-content .body.markup") ??
    root.querySelector(".body.markup") ??
    root.querySelector(".available-content") ??
    root.querySelector("article");
  const contentHtml = body ? body.innerHTML : "";
  const images = body
    ? body
        .querySelectorAll("img")
        .map((img) => img.getAttribute("src") ?? "")
        .filter((src) => src.startsWith("http"))
    : [];
  return { contentHtml, contentText: toPlainText(contentHtml), images };
}

/** Fetch one article's page and return its full inert content. */
export async function fetchArticle(item: ArchiveItem, opts: ArchiveOpts = {}): Promise<Post | null> {
  let html: string;
  try {
    // Confine the article fetch (and any redirect) to the article's OWN domain.
    let expected: string | undefined;
    try {
      expected = canonicalizeDomain(new URL(item.url).hostname) || undefined;
    } catch {
      return null;
    }
    const guarded = { ...opts, validateUrl: (u: string) => assertSafeUrl(u, opts.resolveHost, expected) };
    const { res } = await fetchWithRedirects(item.url, guarded);
    if (!res.ok) return null;
    html = await readCappedText(res, MAX_ARTICLE_BYTES, opts.timeoutMs ?? READ_TIMEOUT_MS);
  } catch {
    return null;
  }
  const { contentHtml, contentText, images } = extractArticle(html);
  if (contentText.length === 0) return null;
  return {
    postId: item.url, // canonical url is the stable id (excerpts reference it)
    title: item.title,
    url: item.url,
    date: item.date,
    contentHtml,
    contentText,
    images,
    locked: false,
    source: "archive",
  };
}

/**
 * The deep article set for a publication: list the archive, keep FREE posts with
 * enough words, then fetch each one's full content. Bounded by `limit`.
 */
export async function fetchDeepArticles(domain: string, opts: ArchiveOpts = {}): Promise<Post[]> {
  const minWords = opts.minWordcount ?? MIN_WORDCOUNT;
  const canonical = canonicalizeDomain(domain);
  if (!canonical) return [];
  // Only fetch FREE, long-enough articles whose URL is ON the publication's own
  // domain — a malicious archive response can't make us fetch arbitrary hosts.
  const items = (await listArchive(domain, opts)).filter(
    (it) => isFreeArticle(it) && it.wordcount >= minWords && samePublication(it.url, canonical),
  );
  const articles: Post[] = [];
  const deadline = Date.now() + FETCH_BUDGET_MS; // bound the whole (sequential) fetch stage
  for (const item of items) {
    if (Date.now() > deadline) break;
    const post = await fetchArticle(item, opts);
    if (post) articles.push(post);
  }
  return articles;
}
