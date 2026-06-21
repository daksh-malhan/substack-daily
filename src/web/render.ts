/**
 * Magazine rendering (PLAN.md MG8). Pure string builders — given a `Magazine`
 * they produce the article markup + the host attributes (vibe class + accent),
 * with NO DOM dependency so they're unit-testable under bun:test. `main.ts` does
 * the actual DOM wiring.
 *
 * Safety: every model/feed-derived value is HTML-escaped, source links are
 * restricted to http(s) and open with `target="_blank" rel="noopener noreferrer"`,
 * and image `src` is kept to LOCAL relative paths only (no scheme / no leading
 * slash) so a magazine.json can never point the page at a remote or absolute URL.
 */
import type { Magazine, MagazineImage } from "../shared/magazine.ts";
import { resolveVibePresetId, safeAccent, vibeClass } from "./vibe.ts";

/** Summary shape returned by `GET /api/library` (one per saved magazine). */
export interface LibrarySummary {
  id: string;
  title: string;
  newsletter: string;
  themes: string[];
  vibePresetId: string;
  accentColor: string;
  generatedAt: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** A source link must be http(s); anything else collapses to an inert "#". */
export function safeHttpUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "#";
  } catch {
    return "#";
  }
}

/**
 * Keep image srcs to in-folder relative paths (offline-safe; no remote/abs).
 * Uses a strict ALLOWLIST, not a denylist, because browsers normalize attribute
 * URLs before fetching — trimming leading/trailing whitespace and stripping
 * tabs/newlines — so " https://evil/x.png" or an embedded control char would
 * sneak a remote load past denylist checks. A real vault path is only plain
 * ASCII word chars, dots, dashes and forward slashes; anything else (whitespace,
 * control chars, ":" scheme, "%" percent-encoding, leading "/" absolute,
 * protocol-relative "//") fails the pattern. ".." segments are then rejected so
 * percent-decoded or literal traversal cannot escape the folder.
 */
export function safeLocalImageSrc(src: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(src)) return null;
  if (src.includes("//")) return null; // no empty/protocol-relative segments
  if (src.split("/").some((segment) => segment === "..")) return null;
  return src;
}

/**
 * Build the same-origin URL that serves a magazine image through the validated
 * `GET /library-assets/:id/*` route (MG10). Both the fresh `/surprise` result and
 * Library entries live in the vault under their slug `id`, so this works online
 * and offline. Returns null (image dropped) if the id or path isn't safe.
 */
export function assetUrl(entryId: string, src: string): string | null {
  const rel = safeLocalImageSrc(src);
  if (!rel) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(entryId)) return null; // id must be a clean slug
  return `/library-assets/${entryId}/${rel}`;
}

/** Host attributes for the article element: the preset class + the accent var. */
export function magazineHostAttrs(magazine: Magazine): { className: string; accent: string; preset: string } {
  return {
    className: `magazine ${vibeClass(magazine.vibePresetId)}`,
    accent: safeAccent(magazine.accentColor),
    preset: resolveVibePresetId(magazine.vibePresetId),
  };
}

function renderFigure(entryId: string, img: MagazineImage): string {
  const src = assetUrl(entryId, img.src);
  if (!src) return "";
  const alt = escapeHtml(img.alt);
  const caption = img.alt ? `<figcaption class="mag-caption">${alt}</figcaption>` : "";
  return `<figure class="mag-figure"><img class="mag-image" src="${escapeHtml(src)}" alt="${alt}" loading="lazy" />${caption}</figure>`;
}

function renderExcerpt(text: string, sourceUrl: string, sourceTitle: string): string {
  const href = safeHttpUrl(sourceUrl);
  const cite =
    href === "#"
      ? `<cite class="mag-cite">— ${escapeHtml(sourceTitle)}</cite>`
      : `<cite class="mag-cite">— <a class="mag-source" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceTitle)}</a></cite>`;
  return `<blockquote class="mag-excerpt"><p>${escapeHtml(text)}</p>${cite}</blockquote>`;
}

/** Render the offline Library list. `data-id` drives open/delete via delegation. */
export function renderLibraryList(entries: LibrarySummary[]): string {
  if (entries.length === 0) {
    return `<p class="lib-empty">No saved magazines yet — hit <strong>Surprise me</strong> to create one.</p>`;
  }
  const cards = entries
    .map((e) => {
      const id = escapeHtml(e.id);
      const date = escapeHtml(e.generatedAt.slice(0, 10));
      const themes = e.themes
        .slice(0, 4)
        .map((t) => `<span class="lib-theme">${escapeHtml(t)}</span>`)
        .join("");
      return [
        `<li class="lib-card" style="--accent: ${safeAccent(e.accentColor)}">`,
        `<button class="lib-open" data-id="${id}" type="button">`,
        `<span class="lib-title">${escapeHtml(e.title)}</span>`,
        `<span class="lib-meta">${escapeHtml(e.newsletter)} · ${date}</span>`,
        themes ? `<span class="lib-themes">${themes}</span>` : "",
        `</button>`,
        `<button class="lib-delete" data-id="${id}" type="button" title="Delete this magazine" aria-label="Delete">✕</button>`,
        `</li>`,
      ].join("");
    })
    .join("");
  return `<ul class="lib-list">${cards}</ul>`;
}

/** Build the article's inner HTML (masthead + intro + sections + footer). */
export function renderMagazineHTML(magazine: Magazine): string {
  const themes = magazine.themes
    .map((t) => `<li class="mag-theme">${escapeHtml(t)}</li>`)
    .join("");

  const newsletterHref = safeHttpUrl(magazine.newsletterUrl);
  const newsletterLink =
    newsletterHref === "#"
      ? escapeHtml(magazine.newsletter)
      : `<a class="mag-source" href="${escapeHtml(newsletterHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(magazine.newsletter)}</a>`;

  const sections = magazine.sections
    .map((section) => {
      const figures = section.images.map((img) => renderFigure(magazine.id, img)).join("");
      const prose = section.prose ? `<p class="mag-prose">${escapeHtml(section.prose)}</p>` : "";
      const excerpts = section.excerpts
        .map((ex) => renderExcerpt(ex.text, ex.sourceUrl, ex.sourceTitle))
        .join("");
      return [
        `<section class="mag-section">`,
        `<hr class="mag-divider" />`,
        `<h2 class="mag-heading">${escapeHtml(section.heading)}</h2>`,
        figures,
        prose,
        excerpts,
        `</section>`,
      ].join("");
    })
    .join("");

  return [
    `<header class="mag-masthead">`,
    `<p class="mag-kicker">Substack Surprise</p>`,
    `<h1 class="mag-title">${escapeHtml(magazine.title)}</h1>`,
    `<p class="mag-byline">from ${newsletterLink}</p>`,
    themes ? `<ul class="mag-themes">${themes}</ul>` : "",
    `</header>`,
    `<p class="mag-intro">${escapeHtml(magazine.intro)}</p>`,
    sections,
    `<footer class="mag-footer">Generated ${escapeHtml(magazine.generatedAt)} · vibe: ${escapeHtml(resolveVibePresetId(magazine.vibePresetId))}</footer>`,
  ].join("");
}
