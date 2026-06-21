/**
 * Domain canonicalization (PLAN.md MG2/MG3). Normalizes any URL-or-host into a
 * bare lowercase hostname so the pool, picker, and (later) fetcher all compare
 * the same form. MG3 extends the fetch side with redirect-following; this module
 * is the pure string normalization shared everywhere.
 */

/** Substack subdomains that are NOT publications — skip when harvesting Discover. */
const RESERVED_SUBSTACK_SUBDOMAINS = new Set([
  "www",
  "open",
  "on",
  "support",
  "help",
  "email",
  "substack",
]);

/**
 * Normalize a URL or bare host to a lowercase hostname with no scheme, port,
 * path, or leading `www.`. Returns null if it can't be parsed into a real host.
 */
export function canonicalizeDomain(input: string): string | null {
  if (!input) return null;
  let host: string;
  try {
    const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    host = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host.includes(".")) return null;
  return host;
}

/**
 * True for a harvestable Substack publication subdomain (`name.substack.com`),
 * excluding reserved subdomains and the apex `substack.com`.
 */
export function isSubstackPublicationHost(host: string): boolean {
  const suffix = ".substack.com";
  if (!host.endsWith(suffix)) return false;
  const sub = host.slice(0, -suffix.length);
  return sub.length > 0 && !sub.includes(".") && !RESERVED_SUBSTACK_SUBDOMAINS.has(sub);
}
