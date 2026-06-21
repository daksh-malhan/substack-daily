/**
 * Hardened image downloader (PLAN.md MG6, addresses review #9). The ONLY place
 * in the app that fetches image bytes. Defends against:
 *   - SSRF: rejects URLs whose host is (or resolves to) a private/loopback IP,
 *     checked at every redirect hop.
 *   - Oversized/slow responses: byte cap + time cap + redirect cap.
 *   - Wrong content: sniffs magic bytes, accepts only png/jpeg/webp/gif, and
 *     explicitly rejects SVG/HTML.
 *   - Tiny images: parses real pixel dimensions and rejects sub-minimum ones.
 * Returns the bytes plus a content hash (for dedupe + hashed filenames).
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 4;
const DEFAULT_MIN_WIDTH = 200;
const DEFAULT_MIN_HEIGHT = 150;

export class ImageDownloadError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`image rejected: ${reason}`);
    this.name = "ImageDownloadError";
    this.reason = reason;
  }
}

export interface DownloadOpts {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  minWidth?: number;
  minHeight?: number;
  /** Override host->public/private resolution (tests). */
  resolveHost?: (host: string) => Promise<boolean>;
}

export interface DownloadedImage {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  ext: "png" | "jpg" | "webp" | "gif";
  width: number;
  height: number;
  hash: string;
}

// ---- SSRF -----------------------------------------------------------------

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]!);
    // IPv4-mapped written in hex groups, e.g. ::ffff:0a00:0001 == ::ffff:10.0.0.1
    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const hi = Number.parseInt(hexMapped[1]!, 16);
      const lo = Number.parseInt(hexMapped[2]!, 16);
      return isPrivateIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
    // Classify by the first 16-bit hextet (full ranges, not just fe80/fc).
    const hi = Number.parseInt((lower.split(":")[0] || "0").padStart(4, "0").slice(0, 2), 16) || 0;
    if (hi === 0xff) return true; // multicast ff00::/8
    if (hi === 0xfc || hi === 0xfd) return true; // unique local fc00::/7
    // fe00::/8 is entirely non-global: link-local fe80::/10, site-local fec0::/10
    // (deprecated), and reserved. None are publicly routable — block all.
    if (hi === 0xfe) return true;
    return false;
  }
  return false; // not an IP literal
}

/**
 * True if the host is safe to fetch (public). Resolves DNS for non-IP hosts.
 * NOTE (accepted residual): there is a TOCTOU window between this lookup and
 * fetch()'s own connect, so a DNS-rebinding attacker could in theory flip a
 * public name to a private IP after validation. Pinning the resolved IP would
 * require bypassing fetch's DNS (and breaks SNI/CDNs); out of scope for a
 * personal local tool fetching public images. We re-validate at every hop.
 */
export async function hostIsPublic(host: string, resolveHost?: (host: string) => Promise<boolean>): Promise<boolean> {
  // URL hostnames for IPv6 are bracketed ("[::1]") — strip before IP checks.
  const bare = host.replace(/^\[|\]$/g, "");
  if (resolveHost) return resolveHost(bare);
  if (isIP(bare)) return !isPrivateIp(bare);
  try {
    const addrs = await lookup(bare, { all: true });
    if (addrs.length === 0) return false;
    return addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

// ---- Sniffing + dimensions -------------------------------------------------

function sniffMime(b: Uint8Array): DownloadedImage["mime"] | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

const EXT: Record<DownloadedImage["mime"], DownloadedImage["ext"]> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}
function u16le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}

/** Parse pixel dimensions for png/gif/jpeg/webp; null if undeterminable. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const mime = sniffMime(b);
  if (mime === "image/png" && b.length >= 24) {
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (mime === "image/gif" && b.length >= 10) {
    return { width: u16le(b, 6), height: u16le(b, 8) };
  }
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
      }
      const len = u16be(b, i + 2);
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  if (mime === "image/webp" && b.length >= 30) {
    const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (fourcc === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (fourcc === "VP8L") {
      const bits = u32be(b, 21);
      // little-endian bitstream; reconstruct from bytes 21..24
      const b0 = b[21]!, b1 = b[22]!, b2 = b[23]!, b3 = b[24]!;
      void bits;
      const w = 1 + (((b1 & 0x3f) << 8) | b0);
      const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width: w, height: h };
    }
    if (fourcc === "VP8X" && b.length >= 30) {
      const w = 1 + ((b[24]! | (b[25]! << 8) | (b[26]! << 16)) & 0xffffff);
      const h = 1 + ((b[27]! | (b[28]! << 8) | (b[29]! << 16)) & 0xffffff);
      return { width: w, height: h };
    }
  }
  return null;
}

// ---- Download --------------------------------------------------------------

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new ImageDownloadError("too large");
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ImageDownloadError("too large");
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function downloadImage(url: string, opts: DownloadOpts = {}): Promise<DownloadedImage> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const minWidth = opts.minWidth ?? DEFAULT_MIN_WIDTH;
  const minHeight = opts.minHeight ?? DEFAULT_MIN_HEIGHT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        throw new ImageDownloadError("bad url");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ImageDownloadError("non-http url");
      }
      if (!(await hostIsPublic(parsed.hostname, opts.resolveHost))) {
        throw new ImageDownloadError("ssrf: non-public host");
      }
      const r = await fetchImpl(current, { redirect: "manual", signal: controller.signal });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) throw new ImageDownloadError("redirect without location");
        current = new URL(loc, current).href;
        continue;
      }
      res = r;
      break;
    }
    if (!res) throw new ImageDownloadError("too many redirects");
    if (!res.ok) throw new ImageDownloadError(`http ${res.status}`);

    const bytes = await readCapped(res, maxBytes);
    const mime = sniffMime(bytes);
    if (!mime) throw new ImageDownloadError("unsupported or non-image content (svg/html rejected)");

    // Require parseable dimensions: an unparseable size means a truncated or
    // structurally invalid raster, which we reject rather than store.
    const size = imageSize(bytes);
    if (!size) throw new ImageDownloadError("undeterminable or truncated image");
    if (size.width < minWidth || size.height < minHeight) {
      throw new ImageDownloadError("below minimum dimensions");
    }

    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    return { bytes, mime, ext: EXT[mime], width: size.width, height: size.height, hash };
  } finally {
    clearTimeout(timer);
  }
}
