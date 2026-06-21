/**
 * Obsidian vault writer (PLAN.md MG6). Persists a magazine ATOMICALLY:
 * everything is assembled under `library/.tmp/<uuid>/` and only renamed into
 * `library/<slug>/` once all assets succeed (+ a `manifest.json` status=complete),
 * so a crash mid-write leaves an ignored temp dir, never a half-valid magazine
 * (review #6). Images are fetched via the hardened downloader (the only byte
 * fetch), content-hash-deduped, and referenced by LOCAL relative paths so the
 * Library works offline. Theme + newsletter notes interlink for the graph
 * (review #12 / R2-#4); all paths go through slugify/resolveInVault (review #7).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Magazine, MagazineSection } from "../shared/magazine.ts";
import { resolveInVault, slugify } from "../shared/paths.ts";
import { atomicWriteFile, Mutex } from "./fsutil.ts";
import { downloadImage, type DownloadOpts } from "./image-download.ts";
import type { ImagePlan } from "./images.ts";

// Serializes updates to shared theme/newsletter notes across concurrent persists.
const notesMutex = new Mutex();

const DEFAULT_MAX_MAGAZINE_BYTES = 24 * 1024 * 1024;

export interface PersistOpts {
  vaultRoot: string;
  fetchImpl?: typeof fetch;
  downloadOpts?: DownloadOpts;
  /** Total downloaded-image budget per magazine (bytes). */
  maxMagazineBytes?: number;
  /** Fixed timestamp for deterministic output (tests). */
  now?: string;
  /** Override the generated slug (tests). */
  slug?: string;
}

export interface PersistResult {
  slug: string;
  dir: string;
  magazine: Magazine;
}

function dateStamp(now: string | undefined): string {
  const d = now ? new Date(now) : new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * A safe slug base for a (possibly long / model-supplied) title: slugify it,
 * truncate to a filesystem-safe length, and fall back to the publication (then a
 * constant) if a candidate reduces to nothing or `slugify` rejects it. Never
 * throws — so one weird cluster theme can't abort a whole multi-magazine run.
 */
function safeSlugBase(title: string, fallback: string): string {
  for (const candidate of [title, fallback]) {
    try {
      const slug = slugify(candidate).slice(0, 80).replace(/-+$/, "");
      if (slug) return slug;
    } catch {
      // unslugifiable (e.g. emoji-only) — try the next candidate
    }
  }
  return "deep-dive";
}

function pickSlug(vaultRoot: string, base: string): string {
  let candidate = base;
  let n = 2;
  while (existsSync(resolveInVault(vaultRoot, candidate))) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"');
}

/** Render the Obsidian note. Pure — excerpts become blockquotes with source links. */
export function renderIndexMd(
  magazine: Magazine,
  themeLinks: { slug: string; name: string }[],
  newsletterLink: { slug: string; name: string },
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`newsletter: "${escapeYaml(magazine.newsletter)}"`);
  lines.push(`date: ${magazine.generatedAt}`);
  lines.push(`vibe: ${magazine.vibePresetId}`);
  lines.push(`accent: "${magazine.accentColor}"`);
  lines.push(`tags: [magazine]`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${magazine.title}`);
  lines.push("");
  lines.push(magazine.intro);
  lines.push("");

  for (const section of magazine.sections) {
    lines.push(`## ${section.heading}`);
    lines.push("");
    for (const img of section.images) {
      lines.push(`![[${img.src}]]`);
      lines.push("");
    }
    if (section.prose) {
      lines.push(section.prose);
      lines.push("");
    }
    for (const ex of section.excerpts) {
      lines.push(`> ${ex.text}`);
      lines.push(`> — [${ex.sourceTitle}](${ex.sourceUrl})`);
      lines.push("");
    }
  }

  if (themeLinks.length > 0) {
    lines.push(
      "**Themes:** " + themeLinks.map((t) => `[[themes/${t.slug}|${t.name}]]`).join(" · "),
    );
  }
  lines.push(`**Newsletter:** [[newsletters/${newsletterLink.slug}|${newsletterLink.name}]]`);
  lines.push("");
  return lines.join("\n");
}

interface NoteGroup {
  name: string;
  entries: { slug: string; title: string }[];
}

async function writeNotes(
  vaultRoot: string,
  subdir: "themes" | "newsletters",
  tag: string,
  map: Map<string, NoteGroup>,
): Promise<void> {
  if (map.size === 0) return;
  await mkdir(resolveInVault(vaultRoot, subdir), { recursive: true });
  for (const [slug, group] of map) {
    const sorted = group.entries.toSorted((a, b) => a.slug.localeCompare(b.slug));
    const body =
      `---\ntags: [${tag}]\n---\n\n# ${group.name}\n\n` +
      sorted.map((e) => `- [[${e.slug}/index|${e.title}]]`).join("\n") +
      "\n";
    await atomicWriteFile(resolveInVault(vaultRoot, join(subdir, `${slug}.md`)), body);
  }
}

/**
 * Rebuild ALL theme/newsletter notes from the complete magazines on disk. Notes
 * are thus a pure function of the magazines, so a crash between publishing a
 * magazine and updating notes self-heals on the next persist (no journal needed).
 */
export async function reconcileNotes(vaultRoot: string): Promise<void> {
  await notesMutex.run(async () => {
    const themeMap = new Map<string, NoteGroup>();
    const nlMap = new Map<string, NoteGroup>();

    let entries: string[];
    try {
      entries = await readdir(vaultRoot);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name === "themes" || name === "newsletters") continue;
      const dir = resolveInVault(vaultRoot, name);
      try {
        const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as { status?: string };
        if (manifest.status !== "complete") continue;
        const mag = JSON.parse(await readFile(join(dir, "magazine.json"), "utf8")) as Magazine;
        const entry = { slug: name, title: mag.title };
        for (const theme of mag.themes) {
          let tslug: string;
          try {
            tslug = slugify(theme);
          } catch {
            continue;
          }
          (themeMap.get(tslug) ?? themeMap.set(tslug, { name: theme, entries: [] }).get(tslug)!).entries.push(entry);
        }
        try {
          const nslug = slugify(mag.newsletter);
          (nlMap.get(nslug) ?? nlMap.set(nslug, { name: mag.newsletter, entries: [] }).get(nslug)!).entries.push(entry);
        } catch {
          // unslugifiable newsletter name — skip its note
        }
      } catch {
        continue; // not a complete magazine dir
      }
    }

    await writeNotes(vaultRoot, "themes", "theme", themeMap);
    await writeNotes(vaultRoot, "newsletters", "newsletter", nlMap);
    // Remove notes no longer referenced by any magazine (pure-function invariant).
    await pruneStaleNotes(vaultRoot, "themes", themeMap);
    await pruneStaleNotes(vaultRoot, "newsletters", nlMap);
  });
}

async function pruneStaleNotes(
  vaultRoot: string,
  subdir: "themes" | "newsletters",
  map: Map<string, NoteGroup>,
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(resolveInVault(vaultRoot, subdir));
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    if (!map.has(f.slice(0, -3))) {
      await rm(resolveInVault(vaultRoot, join(subdir, f)), { force: true }).catch(() => {});
    }
  }
}

export async function persistMagazine(plan: ImagePlan, opts: PersistOpts): Promise<PersistResult> {
  const { vaultRoot } = opts;
  await mkdir(vaultRoot, { recursive: true });

  // The magazine title (deep-dives set a per-cluster theme title; else the
  // publication name). Slug derives from the TITLE so multiple deep-dives from
  // one publication get distinct folders; provenance/graph still use `newsletter`.
  // Title is model/cluster text, so the slug base is made robust: truncated to a
  // filesystem-safe length and falling back if slugify rejects it (e.g. emoji).
  const title = plan.title ?? plan.newsletter;
  const slug = opts.slug ?? pickSlug(vaultRoot, `${safeSlugBase(title, plan.newsletter)}-${dateStamp(opts.now)}`);
  const generatedAt = opts.now ?? new Date().toISOString();

  const tmpDir = resolveInVault(vaultRoot, join(".tmp", randomUUID()));
  const imagesDir = join(tmpDir, "images");
  await mkdir(imagesDir, { recursive: true });

  try {
    // Download + dedupe images; fall back to a section with no image on failure.
    const maxMagBytes = opts.maxMagazineBytes ?? DEFAULT_MAX_MAGAZINE_BYTES;
    let totalBytes = 0;
    const hashToFile = new Map<string, string>();
    const sections: MagazineSection[] = [];
    for (const section of plan.sections) {
      const images: MagazineSection["images"] = [];
      if (section.image.kind === "image") {
        try {
          const dl = await downloadImage(section.image.candidate.url, {
            fetchImpl: opts.fetchImpl,
            ...opts.downloadOpts,
          });
          let file = hashToFile.get(dl.hash);
          if (!file) {
            // Enforce the per-magazine total-asset budget (new bytes only).
            if (totalBytes + dl.bytes.length > maxMagBytes) {
              throw new Error("magazine asset budget exceeded");
            }
            file = `${dl.hash}.${dl.ext}`;
            await writeFile(join(imagesDir, file), dl.bytes);
            hashToFile.set(dl.hash, file);
            totalBytes += dl.bytes.length;
          }
          images.push({ src: `images/${file}`, alt: section.image.candidate.alt });
        } catch {
          // graceful: a rejected/over-budget image renders this section typographically
        }
      }
      sections.push({
        heading: section.heading,
        prose: section.prose,
        excerpts: section.excerpts.map((e) => ({
          text: e.text,
          sourceUrl: e.sourceUrl,
          sourceTitle: e.sourceTitle,
        })),
        images,
      });
    }

    const magazine: Magazine = {
      id: slug,
      newsletter: plan.newsletter,
      newsletterUrl: `https://${plan.domain}`,
      title,
      intro: plan.intro,
      themes: plan.themes,
      vibePresetId: plan.vibePresetId,
      accentColor: plan.accentColor,
      sections,
      generatedAt,
    };

    const newsletterLink = { slug: slugify(plan.newsletter), name: plan.newsletter };
    const themeLinks = plan.themes
      .map((t) => {
        try {
          return { slug: slugify(t), name: t };
        } catch {
          return null;
        }
      })
      .filter((x): x is { slug: string; name: string } => x !== null);

    await writeFile(join(tmpDir, "magazine.json"), JSON.stringify(magazine, null, 2));
    await writeFile(join(tmpDir, "index.md"), renderIndexMd(magazine, themeLinks, newsletterLink));
    await writeFile(
      join(tmpDir, "manifest.json"),
      JSON.stringify({ status: "complete", slug, newsletter: plan.newsletter, generatedAt }, null, 2),
    );

    // Atomic publish: a single rename makes the magazine visible all at once.
    const finalDir = resolveInVault(vaultRoot, slug);
    await rename(tmpDir, finalDir);

    // Rebuild graph notes from the complete magazines on disk (crash-consistent).
    await reconcileNotes(vaultRoot);

    return { slug, dir: finalDir, magazine };
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
