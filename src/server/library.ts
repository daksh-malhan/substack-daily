/**
 * Offline Library backend (PLAN.md MG10, addresses R2-#3 / #8 / #13). Reads the
 * vault the pipeline writes and serves it back with NO network and NO codex, so
 * the website works on a plane. Everything here is the security boundary for
 * "serve/delete local files by id":
 *
 *   - An entry id from a request is ONLY trusted after `validateEntryId` (it must
 *     already be a clean slug, never a reserved dir, dotfile, or `.tmp`).
 *   - Every path goes through `resolveInVault` (lexical containment) — twice for
 *     assets (id under the vault, then asset under the entry).
 *   - Only entries with a `complete` manifest are listed/read/served; partial
 *     `.tmp` assembly is invisible.
 *   - The asset route serves ONLY files under the entry's `images/` dir with a
 *     known image content-type; raw paths from `magazine.json` are never trusted.
 */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Magazine } from "../shared/magazine.ts";
import { resolveInVault, slugify } from "../shared/paths.ts";
import { reconcileNotes } from "./vault.ts";

// Runtime shape for a persisted magazine. A `complete` manifest is not enough —
// a hand-edited / corrupt magazine.json must not poison the Library, so we
// validate before listing or rendering it.
const MagazineSchema = z.object({
  id: z.string(),
  newsletter: z.string(),
  newsletterUrl: z.string(),
  title: z.string(),
  intro: z.string(),
  themes: z.array(z.string()),
  vibePresetId: z.string(),
  accentColor: z.string(),
  generatedAt: z.string(),
  sections: z.array(
    z.object({
      heading: z.string(),
      prose: z.string(),
      excerpts: z.array(z.object({ text: z.string(), sourceUrl: z.string(), sourceTitle: z.string() })),
      images: z.array(z.object({ src: z.string(), alt: z.string() })),
    }),
  ),
});

/** Dirs in the vault root that are NOT magazines. */
const RESERVED_DIRS = new Set(["themes", "newsletters"]);

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export interface LibraryEntry {
  id: string;
  title: string;
  newsletter: string;
  themes: string[];
  vibePresetId: string;
  accentColor: string;
  generatedAt: string;
}

/**
 * Return a SAFE entry id, or null if the input can't be trusted. The id must be
 * exactly what `slugify` produces for itself (so any `..`, slash, dotfile, space,
 * or uppercase round-trips to something different and is rejected) and must not
 * name a reserved dir.
 */
export function validateEntryId(entryId: string): string | null {
  if (typeof entryId !== "string" || entryId.length === 0) return null;
  if (RESERVED_DIRS.has(entryId)) return null;
  let slug: string;
  try {
    slug = slugify(entryId);
  } catch {
    return null;
  }
  return slug === entryId ? slug : null;
}

async function isCompleteEntry(vaultRoot: string, id: string): Promise<boolean> {
  try {
    const dir = resolveInVault(vaultRoot, id);
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as { status?: string };
    return manifest.status === "complete";
  } catch {
    return false;
  }
}

/** List complete magazines, newest first. Skips dotfiles, reserved dirs, and partial/.tmp entries. */
export async function listLibrary(vaultRoot: string): Promise<LibraryEntry[]> {
  let names: string[];
  try {
    names = await readdir(vaultRoot);
  } catch {
    return [];
  }
  const entries: LibraryEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".") || RESERVED_DIRS.has(name)) continue;
    const id = validateEntryId(name);
    if (!id) continue;
    if (!(await isCompleteEntry(vaultRoot, id))) continue;
    const mag = await readMagazine(vaultRoot, id);
    if (!mag) continue;
    entries.push({
      id,
      title: mag.title,
      newsletter: mag.newsletter,
      themes: mag.themes,
      vibePresetId: mag.vibePresetId,
      accentColor: mag.accentColor,
      generatedAt: mag.generatedAt,
    });
  }
  return entries.toSorted((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

/**
 * Read a complete magazine for rendering, or null if the id is bad/incomplete/
 * missing, the JSON is malformed/invalid-shape, or its `id` doesn't match the
 * folder (an entry can't impersonate another — `id` is what assetUrl trusts).
 */
export async function readMagazine(vaultRoot: string, entryId: string): Promise<Magazine | null> {
  const id = validateEntryId(entryId);
  if (!id) return null;
  if (!(await isCompleteEntry(vaultRoot, id))) return null;
  try {
    const dir = resolveInVault(vaultRoot, id);
    const parsed = MagazineSchema.safeParse(JSON.parse(await readFile(join(dir, "magazine.json"), "utf8")));
    if (!parsed.success || parsed.data.id !== id) return null;
    return parsed.data as Magazine;
  } catch {
    return null;
  }
}

/**
 * Validate a `GET /library-assets/:id/*` request to an absolute file path +
 * content-type, or null to reject. Serves ONLY `images/<file>` of a COMPLETE
 * entry, with a recognized image extension; rejects traversal, dotfiles, and
 * anything outside the entry's images dir.
 */
export async function resolveAsset(
  vaultRoot: string,
  entryId: string,
  relPath: string,
): Promise<{ absPath: string; contentType: string } | null> {
  const id = validateEntryId(entryId);
  if (!id) return null;
  if (!(await isCompleteEntry(vaultRoot, id))) return null;

  // Only the entry's images/ dir is exposed; the path must be exactly images/<file>.
  const segments = relPath.split("/").filter((s) => s.length > 0);
  if (segments.length !== 2 || segments[0] !== "images") return null;
  const file = segments[1]!;
  if (file.startsWith(".") || file.includes("\\")) return null;

  const ext = file.includes(".") ? file.slice(file.lastIndexOf(".") + 1).toLowerCase() : "";
  const contentType = IMAGE_CONTENT_TYPES[ext];
  if (!contentType) return null;

  let absPath: string;
  try {
    const dir = resolveInVault(vaultRoot, id);
    absPath = resolveInVault(dir, join("images", file)); // double containment
  } catch {
    return null;
  }
  try {
    if (!(await stat(absPath)).isFile()) return null;
  } catch {
    return null;
  }
  return { absPath, contentType };
}

/** Delete a magazine by validated id and reconcile graph notes. */
export async function deleteEntry(vaultRoot: string, entryId: string): Promise<"ok" | "not-found" | "invalid"> {
  const id = validateEntryId(entryId);
  if (!id) return "invalid";
  if (!(await isCompleteEntry(vaultRoot, id))) return "not-found";
  const dir = resolveInVault(vaultRoot, id); // contained
  await rm(dir, { recursive: true, force: true });
  await reconcileNotes(vaultRoot); // prune now-orphaned theme/newsletter notes
  return "ok";
}
