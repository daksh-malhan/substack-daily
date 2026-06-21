/**
 * Local-server hardening (PLAN.md MG1, addresses R3-#1; tightened per MG1 Codex review).
 *
 * The app binds to 127.0.0.1 only, but a malicious web page (or DNS-rebinding
 * attack) can still aim requests at `localhost`. These guards:
 *   - reject any request whose `Host` is not a loopback name (rebinding defense),
 *   - require mutating routes to be EXACT same-origin JSON (CSRF defense),
 *   - reject cross-origin reads of `/library-assets` (local-file exfiltration defense).
 *
 * "Same-origin" is an exact scheme+host+port match against the request's own Host,
 * not merely "some loopback origin" — a page on a different localhost port is still
 * cross-origin and is rejected.
 *
 * Pure functions over `Request` so they're unit-testable without a socket.
 */

const LOCAL_HOSTNAMES = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

/** Extract the bare hostname from a `Host` header value (strips the port). */
export function hostnameFromHostHeader(host: string | null): string | null {
  if (!host) return null;
  const trimmed = host.trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    return close === -1 ? trimmed : trimmed.slice(0, close + 1);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/** True if a `Host` header points at a loopback name. */
export function isLocalHost(host: string | null): boolean {
  const name = hostnameFromHostHeader(host);
  return name !== null && LOCAL_HOSTNAMES.has(name.toLowerCase());
}

/** True if an `Origin` header is a well-formed URL on a loopback host (host check only). */
export function originIsLocal(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const { hostname } = new URL(origin);
    return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * EXACT same-origin: the Origin's FULL origin (scheme + host + port) must equal
 * the request's own origin. Our server is http-on-loopback, so the expected
 * origin is `http://<Host>` — this rejects cross-scheme (https), cross-host, and
 * cross-port origins alike.
 */
export function originMatchesHost(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).origin.toLowerCase() === new URL(`http://${host.trim()}`).origin.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Fetch-metadata defense: a cross-site `<img>`/`<link>`/form load omits `Origin`,
 * so the Origin check alone can't catch it. Modern browsers DO send
 * `Sec-Fetch-Site`; reject anything that isn't same-origin. Absent (non-browser
 * clients, older browsers) and `none` (top-level navigation) are allowed, so
 * curl and direct navigation still work.
 */
export function secFetchSiteBlocks(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}

/** Exact JSON media type (ignores parameters); rejects substring spoofs. */
export function isJsonContentType(value: string | null): boolean {
  const mediaType = (value ?? "").split(";")[0]!.trim().toLowerCase();
  return mediaType === "application/json";
}

/** HTTP methods that change state — must pass the same-origin JSON check. */
export function isMutatingMethod(method: string): boolean {
  return !(method === "GET" || method === "HEAD" || method === "OPTIONS");
}

function deny(status: number, reason: string): Response {
  return Response.json({ error: reason }, { status });
}

export type RouteKind = "static" | "mutating" | "asset";

/**
 * Returns a rejection `Response` if the request fails the security checks,
 * or `null` if it passes.
 *   - "mutating": loopback Host + EXACT same-origin Origin + JSON content-type.
 *   - "asset":    loopback Host + (if an Origin is present) EXACT same-origin.
 *   - "static":   loopback Host only.
 */
export function securityCheck(req: Request, kind: RouteKind): Response | null {
  const host = req.headers.get("host");

  // Rebinding defense: every request must carry a loopback Host.
  if (!isLocalHost(host)) {
    return deny(403, "non-local Host header rejected");
  }

  const origin = req.headers.get("origin");

  // Fetch-metadata defense for both protected kinds: a cross-site request that
  // omits Origin (e.g. an <img> load) is still caught by Sec-Fetch-Site.
  if (kind === "mutating" || kind === "asset") {
    if (secFetchSiteBlocks(req)) {
      return deny(403, "cross-site request rejected (Sec-Fetch-Site)");
    }
  }

  if (kind === "mutating") {
    // CSRF defense: an exact same-origin Origin is required.
    if (!originMatchesHost(origin, host)) {
      return deny(403, "mutating request requires an exact same-origin Origin");
    }
    if (!isJsonContentType(req.headers.get("content-type"))) {
      return deny(415, "mutating request requires Content-Type: application/json");
    }
  } else if (kind === "asset") {
    // Block cross-origin reads of local files. Same-origin requests and
    // top-level navigations (which send no Origin) are allowed.
    if (origin !== null && !originMatchesHost(origin, host)) {
      return deny(403, "cross-origin asset request rejected");
    }
  }

  return null;
}
