/**
 * Image acquisition (PLAN.md MG5). METADATA/URL FILTERING ONLY — this stage
 * never fetches image bytes (that's MG6, addresses R2-#2). It harvests post
 * image URLs, queries Google CSE (image mode) for "vibe" candidates, filters by
 * provider-reported dimensions + URL patterns (rejecting avatars/icons/tracking
 * pixels), and maps a candidate to every section — falling back to a typographic
 * block when nothing fits, so no section is ever left without a plan.
 */
import type { Post } from "../shared/post.ts";
import type { SynthesisResult, SynthSection } from "./synth.ts";

const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;
const CSE_PER_QUERY = 4;
const CSE_MAX_QUERIES = 4;

export interface ImageCandidate {
  url: string;
  source: "post" | "cse";
  width?: number;
  height?: number;
  query?: string;
  alt: string;
}

export type SectionImage = { kind: "image"; candidate: ImageCandidate } | { kind: "typographic" };

export interface PlannedSection extends SynthSection {
  image: SectionImage;
}

export interface ImagePlan extends Omit<SynthesisResult, "sections"> {
  sections: PlannedSection[];
  /** True if Google CSE was used (key+cx present and a query returned candidates). */
  usedCse: boolean;
}

/** Reject obvious non-content images (avatars, icons, logos, tracking pixels). */
export function urlLooksLikeIcon(url: string): boolean {
  return /(avatar|favicon|gravatar|profile[_-]|\/icon|[_-]icon|logo|tracking|pixel|spacer|emoji|badge|1x1)/i.test(
    url,
  );
}

/** Substack CDN URLs embed the resized width as `/w_1456,...`. Returns it if present. */
export function substackWidthFromUrl(url: string): number | null {
  const m = url.match(/\/w_(\d+)/);
  return m ? Number(m[1]) : null;
}

function postImageOk(url: string): boolean {
  if (urlLooksLikeIcon(url)) return false;
  const w = substackWidthFromUrl(url);
  return w === null || w >= MIN_WIDTH;
}

/** Build deduped post-image candidates, keyed by the post that contained them. */
export function harvestPostImages(posts: Post[]): Map<string, ImageCandidate[]> {
  const byPost = new Map<string, ImageCandidate[]>();
  const seen = new Set<string>();
  for (const post of posts) {
    const list: ImageCandidate[] = [];
    for (const url of post.images) {
      if (seen.has(url) || !postImageOk(url)) continue;
      seen.add(url);
      list.push({
        url,
        source: "post",
        width: substackWidthFromUrl(url) ?? undefined,
        alt: post.title,
      });
    }
    if (list.length > 0) byPost.set(post.postId, list);
  }
  return byPost;
}

// ---- Google Custom Search (image mode) -------------------------------------

interface CseItem {
  link?: string;
  image?: { width?: number; height?: number };
}

const CSE_TIMEOUT_MS = 10_000; // a stalled CSE call must not hold the pipeline (and the guard)

export interface CseOpts {
  key: string;
  cx: string;
  fetchImpl?: typeof fetch;
  num?: number;
  timeoutMs?: number;
}

/** Query Google CSE image mode for one query. Best-effort: returns [] on any failure. */
export async function cseImageSearch(query: string, opts: CseOpts): Promise<ImageCandidate[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const num = opts.num ?? CSE_PER_QUERY;
  const url =
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(opts.key)}` +
    `&cx=${encodeURIComponent(opts.cx)}&searchType=image&num=${num}&q=${encodeURIComponent(query)}`;
  let data: { items?: CseItem[] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? CSE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return [];
    data = (await res.json()) as { items?: CseItem[] };
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
  const out: ImageCandidate[] = [];
  for (const item of data.items ?? []) {
    const link = item.link;
    if (!link || urlLooksLikeIcon(link)) continue;
    const width = item.image?.width;
    const height = item.image?.height;
    if ((width !== undefined && width < MIN_WIDTH) || (height !== undefined && height < MIN_HEIGHT)) continue;
    out.push({ url: link, source: "cse", width, height, query, alt: query });
  }
  return out;
}

// ---- Orchestration ---------------------------------------------------------

export interface AcquireOpts {
  googleKey?: string;
  googleCseId?: string;
  fetchImpl?: typeof fetch;
  warn?: (msg: string) => void;
}

/**
 * Plan one image per section. Prefers an image from the section's own source
 * posts; else a CSE "vibe" image; else a typographic fallback. Never fetches
 * bytes and never leaves a section without a plan.
 */
export async function acquireImages(
  synth: SynthesisResult,
  posts: Post[],
  opts: AcquireOpts = {},
): Promise<ImagePlan> {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const postImages = harvestPostImages(posts);

  // Vibe pool from Google CSE (only when configured).
  const vibePool: ImageCandidate[] = [];
  let usedCse = false;
  if (opts.googleKey && opts.googleCseId) {
    const queries = synth.imageQueries.slice(0, CSE_MAX_QUERIES);
    const seen = new Set<string>();
    for (const query of queries) {
      const found = await cseImageSearch(query, {
        key: opts.googleKey,
        cx: opts.googleCseId,
        fetchImpl: opts.fetchImpl,
      });
      for (const c of found) {
        if (!seen.has(c.url)) {
          seen.add(c.url);
          vibePool.push(c);
        }
      }
    }
    usedCse = vibePool.length > 0;
  } else {
    warn("images: GOOGLE_CSE_KEY/GOOGLE_CSE_ID not set — using post images only.");
  }

  const used = new Set<string>();
  let vibeIdx = 0;
  const takeVibe = (): ImageCandidate | null => {
    while (vibeIdx < vibePool.length) {
      const c = vibePool[vibeIdx++]!;
      if (!used.has(c.url)) {
        used.add(c.url);
        return c;
      }
    }
    return null;
  };

  const sections: PlannedSection[] = synth.sections.map((section): PlannedSection => {
    // 1) a post image from one of this section's source posts
    for (const ex of section.excerpts) {
      const candidates = postImages.get(ex.postId) ?? [];
      const fresh = candidates.find((c) => !used.has(c.url));
      if (fresh) {
        used.add(fresh.url);
        return { ...section, image: { kind: "image", candidate: fresh } };
      }
    }
    // 2) a vibe image
    const vibe = takeVibe();
    if (vibe) return { ...section, image: { kind: "image", candidate: vibe } };
    // 3) typographic fallback
    return { ...section, image: { kind: "typographic" } };
  });

  return {
    newsletter: synth.newsletter,
    domain: synth.domain,
    title: synth.title,
    intro: synth.intro,
    themes: synth.themes,
    vibePresetId: synth.vibePresetId,
    accentColor: synth.accentColor,
    imageQueries: synth.imageQueries,
    sections,
    usedCse,
  };
}
