/**
 * Filesystem-path safety for the Obsidian vault / library (PLAN.md MG0,
 * addresses review #7 / #8 / R2-#4).
 *
 *   - `slugify(name)` -> portable `[a-z0-9-]` slug; rejects empty/reserved names.
 *   - `uniqueSlug(name, taken)` -> slug with a numeric collision suffix,
 *     deduped case-insensitively (macOS filesystems are case-insensitive).
 *   - `resolveInVault(root, rel)` -> absolute path, THROWS if it escapes `root`.
 */
import { resolve, sep } from "node:path";

// Windows-reserved device names — rejected so vaults stay portable across OSes.
const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Convert an arbitrary display name into a safe, portable slug. Throws if it reduces to nothing or a reserved name. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (slug === "") {
    throw new Error(`slugify: name reduced to an empty slug: ${JSON.stringify(name)}`);
  }
  if (RESERVED.has(slug)) {
    throw new Error(`slugify: refusing reserved name: ${slug}`);
  }
  return slug;
}

/**
 * Slugify `name`, appending `-2`, `-3`, ... if it collides with an existing
 * slug. `taken` holds already-used slugs; comparison is case-insensitive.
 * The returned slug is added to `taken`.
 */
export function uniqueSlug(name: string, taken: Set<string>): string {
  const base = slugify(name);
  const has = (s: string): boolean => taken.has(s.toLowerCase());

  let candidate = base;
  let n = 2;
  while (has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Resolve `rel` under `root` and guarantee containment. Throws on any path
 * that escapes the vault root (`..`, absolute paths, etc.). Use for EVERY
 * read/write/delete that derives a path from model output or request input.
 *
 * NOTE: containment is LEXICAL (path-resolution only). It does not follow
 * symlinks, so a pre-existing symlink inside a user's own vault could point
 * outside it. Accepted for a personal local tool: the vault is user-owned, and
 * all model/request-derived segments pass through `slugify` (allowlisted
 * `[a-z0-9-]`), so they cannot introduce traversal or create symlinks.
 */
export function resolveInVault(root: string, rel: string): string {
  const absRoot = resolve(root);
  const target = resolve(absRoot, rel);
  if (target !== absRoot && !target.startsWith(absRoot + sep)) {
    throw new Error(`resolveInVault: path escapes vault root: ${JSON.stringify(rel)}`);
  }
  return target;
}
