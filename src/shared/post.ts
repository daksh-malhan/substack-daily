/**
 * Fetched-post types (PLAN.md MG3). A `Post` is the unit the synthesis step
 * (MG4) consumes. CRITICAL: only `contentText` (inert, normalized) is ever sent
 * to Codex — never `contentHtml` (addresses review #2 input side).
 */
export interface Post {
  /** Stable id: RSS guid, else the post url. Excerpts reference this (MG4). */
  postId: string;
  title: string;
  url: string;
  /** ISO 8601, or null if the feed date was missing/unparseable. */
  date: string | null;
  /** Raw RSS HTML. NEVER sent to Codex — kept for image extraction/provenance. */
  contentHtml: string;
  /** Inert plain text (shared toPlainText + normalize). THIS is what Codex sees. */
  contentText: string;
  /** Absolute image URLs harvested from the post HTML. */
  images: string[];
  /** True if the post looks paywalled/truncated (teaser only). */
  locked: boolean;
  /** Where this post came from. */
  source: "rss" | "archive";
}

export interface FetchResult {
  /** Publication (channel) title. */
  newsletter: string;
  /** Canonical domain the pick resolved to. */
  domain: string;
  /** The resolved feed URL (after redirects). */
  feedUrl: string;
  posts: Post[];
  /** Whether the best-effort archive scrape contributed any new posts. */
  archiveOk: boolean;
}
