/**
 * HTTP fetch with timeout, bounded retry, and manual redirect-following
 * (PLAN.md MG3, addresses review #4). Manual redirects let us track the final
 * URL (custom-domain / canonical-subdomain resolution) and keep it testable with
 * an injected `fetchImpl`. A structured `FetchError` is thrown on failure.
 */
const USER_AGENT = "Mozilla/5.0 substack-surprise-magazine/0.0 (+local tool)";

export class FetchError extends Error {
  readonly detail: { domain?: string; status?: number; cause?: string };
  constructor(message: string, detail: { domain?: string; status?: number; cause?: string } = {}) {
    super(message);
    this.name = "FetchError";
    this.detail = detail;
  }
}

export interface FetchOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  maxHops?: number;
  /**
   * Called for the initial URL and EVERY redirect target before it is fetched;
   * throw to reject (SSRF guard for content-derived URLs). May be async.
   */
  validateUrl?: (url: string) => void | Promise<void>;
}

export interface FetchOutcome {
  res: Response;
  finalUrl: string;
}

async function fetchOnce(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/rss+xml, application/xml, text/xml, text/html;q=0.8",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  retries: number,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchOnce(fetchImpl, url, timeoutMs);
      if (res.status >= 500 && attempt < retries) {
        lastError = new FetchError(`server error ${res.status}`, { status: res.status });
        continue;
      }
      return res;
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
    }
  }
  throw new FetchError("network request failed", { cause: String(lastError) });
}

/** Fetch following up to `maxHops` redirects manually; returns the final response + URL. */
export async function fetchWithRedirects(url: string, opts: FetchOpts = {}): Promise<FetchOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 2;
  const maxHops = opts.maxHops ?? 5;

  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (opts.validateUrl) await opts.validateUrl(current); // SSRF guard at every hop
    const res = await fetchWithRetry(fetchImpl, current, timeoutMs, retries);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { res, finalUrl: current };
      current = new URL(location, current).href;
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new FetchError("too many redirects", { cause: "max_hops", domain: new URL(url).hostname });
}
