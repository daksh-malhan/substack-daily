/**
 * Publication fetcher orchestration (PLAN.md MG3).
 *
 * domain -> canonicalize -> GET <domain>/feed (redirect/timeout/retry) -> verify
 * it's a Substack feed -> parse posts -> best-effort GET /archive to add older
 * posts (graceful on failure) -> FetchResult. Throws a structured FetchError on
 * a missing/invalid/non-Substack/blocked feed.
 */
import { canonicalizeDomain } from "../shared/domains.ts";
import type { FetchResult, Post } from "../shared/post.ts";
import { archiveRefToPost, parseArchive } from "./archive-parse.ts";
import { isSubstackFeed, parseRssFeed } from "./feed-parse.ts";
import { FetchError, type FetchOpts, fetchWithRedirects } from "./http.ts";

export async function fetchPublication(domain: string, opts: FetchOpts = {}): Promise<FetchResult> {
  const canonicalDomain = canonicalizeDomain(domain);
  if (!canonicalDomain) {
    throw new FetchError("invalid domain", { domain });
  }

  const feedUrl = `https://${canonicalDomain}/feed`;
  let outcome;
  try {
    outcome = await fetchWithRedirects(feedUrl, opts);
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw new FetchError("feed fetch failed", { domain: canonicalDomain, cause: String(error) });
  }

  if (!outcome.res.ok) {
    throw new FetchError(`feed fetch returned HTTP ${outcome.res.status}`, {
      domain: canonicalDomain,
      status: outcome.res.status,
    });
  }

  const xmlText = await outcome.res.text();
  if (!/<rss[\s>]/i.test(xmlText)) {
    throw new FetchError("response is not an RSS feed", { domain: canonicalDomain });
  }

  let feed;
  try {
    // Pass the final feed URL so relative item links resolve to absolute.
    feed = parseRssFeed(xmlText, outcome.finalUrl);
  } catch {
    throw new FetchError("failed to parse feed", { domain: canonicalDomain });
  }

  if (!isSubstackFeed(feed, outcome.finalUrl)) {
    throw new FetchError("not a Substack feed", { domain: canonicalDomain });
  }
  if (feed.posts.length === 0) {
    throw new FetchError("feed has no posts", { domain: canonicalDomain });
  }

  // Reflect the host the feed actually resolved to (after any redirect).
  const resolvedDomain = canonicalizeDomain(outcome.finalUrl) ?? canonicalDomain;

  const posts: Post[] = [...feed.posts];
  const knownUrls = new Set(posts.map((p) => p.url).filter(Boolean));
  let archiveOk = false;

  // Best-effort archive: never let a failure abort the build (RSS-only fallback).
  try {
    const archiveUrl = new URL("/archive", outcome.finalUrl).href;
    const archiveOutcome = await fetchWithRedirects(archiveUrl, opts);
    if (archiveOutcome.res.ok) {
      const html = await archiveOutcome.res.text();
      for (const ref of parseArchive(html, archiveOutcome.finalUrl)) {
        if (!knownUrls.has(ref.url)) {
          knownUrls.add(ref.url);
          posts.push(archiveRefToPost(ref));
          archiveOk = true;
        }
      }
    }
  } catch {
    archiveOk = false; // graceful: keep RSS posts
  }

  return {
    newsletter: feed.title,
    domain: resolvedDomain,
    feedUrl: outcome.finalUrl,
    posts,
    archiveOk,
  };
}
