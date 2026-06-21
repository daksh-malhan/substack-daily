/**
 * `bun run smoke:cse` (PLAN.md MG5). MANUAL live check of Google CSE image
 * search — kept OUT of the test suite so automated tests stay fixture-only.
 * Reads GOOGLE_CSE_KEY / GOOGLE_CSE_ID from the environment (or .env).
 */
import { cseImageSearch } from "../src/server/images.ts";

const key = process.env.GOOGLE_CSE_KEY;
const cx = process.env.GOOGLE_CSE_ID;
if (!key || !cx) {
  console.error("smoke:cse — set GOOGLE_CSE_KEY and GOOGLE_CSE_ID (see .env.example) to run this.");
  process.exit(1);
}

const query = process.argv[2] ?? "vintage cartography illustration";
console.log(`Querying Google CSE (image) for: ${query}`);
const results = await cseImageSearch(query, { key, cx });
console.log(`Got ${results.length} candidate(s):`);
for (const c of results) {
  console.log(`  ${c.width ?? "?"}x${c.height ?? "?"}  ${c.url}`);
}
