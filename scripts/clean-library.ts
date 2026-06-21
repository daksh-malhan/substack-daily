/**
 * Reset the local Obsidian vault (`./library/`, or $VAULT_ROOT) to an
 * empty-but-valid state: remove every persisted magazine entry plus the
 * generated graph notes (`themes/`, `newsletters/`), the staging dir (`.tmp`),
 * and macOS `.DS_Store` cruft — while KEEPING the Obsidian config (`.obsidian`)
 * and `.gitkeep`, so Obsidian still opens the folder as the SAME vault.
 *
 * New `/surprise` runs repopulate it automatically: `persistMagazine` writes
 * `library/<slug>/{index.md, magazine.json, manifest.json, images/}` atomically
 * and `reconcileNotes` rebuilds the `[[theme]]`/`[[newsletter]]` notes — so the
 * Library UI and the Obsidian graph both stay correct with no manual step.
 *
 * Idempotent. Run: `export PATH="$HOME/.bun/bin:$PATH"; bun run clean:library`
 */
import { existsSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { reconcileNotes } from "../src/server/vault.ts";

const vaultRoot = process.env.VAULT_ROOT
  ? resolve(process.env.VAULT_ROOT)
  : resolve(import.meta.dir, "..", "library");

// Everything else in the vault is app-generated and safe to remove.
const KEEP = new Set([".obsidian", ".gitkeep"]);

async function main(): Promise<void> {
  if (!existsSync(vaultRoot)) {
    console.log(`no vault at ${vaultRoot} — nothing to clean`);
    return;
  }
  const entries = await readdir(vaultRoot);
  let magazines = 0;
  for (const name of entries) {
    if (KEEP.has(name)) continue;
    // Count real magazine entries (have a manifest) for an honest report.
    if (existsSync(join(vaultRoot, name, "manifest.json"))) magazines += 1;
    await rm(join(vaultRoot, name), { recursive: true, force: true });
  }
  // Rebuild graph notes from the (now zero) magazines — proves the vault is
  // left in the same valid state the live pipeline maintains.
  await reconcileNotes(vaultRoot);
  // Keep the folder tracked/openable even when empty.
  if (!existsSync(join(vaultRoot, ".gitkeep"))) await writeFile(join(vaultRoot, ".gitkeep"), "");
  console.log(
    `cleaned ${vaultRoot}: removed ${magazines} magazine${magazines === 1 ? "" : "s"} + generated notes; kept .obsidian + .gitkeep`,
  );
}

await main();
