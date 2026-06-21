/**
 * `bun run refresh-pool` (PLAN.md MG2). Best-effort: scrape substack.com/discover
 * and append any newly-found Substack publication domains to config/pool.json,
 * deduped + atomic-write. Out of the hot path; failures are non-fatal to the app.
 */
import { resolve } from "node:path";
import { refreshPool } from "../src/server/pool.ts";

const DISCOVER_URL = "https://substack.com/discover";
const poolPath = resolve(import.meta.dir, "../config/pool.json");

const res = await fetch(DISCOVER_URL, {
  headers: { "user-agent": "Mozilla/5.0 substack-surprise-magazine/0.0 (+local tool)" },
});
if (!res.ok) {
  console.error(`refresh-pool: discover fetch failed (HTTP ${res.status}).`);
  process.exit(1);
}

const html = await res.text();
const { added, total } = await refreshPool(poolPath, html);
console.log(`refresh-pool: added ${added} new domain(s); pool now has ${total}.`);
if (added === 0) {
  console.log(
    "(0 added — Discover markup may have changed, or all results were already pooled / custom-domain. This is best-effort.)",
  );
}
