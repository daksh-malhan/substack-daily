import { describe, expect, test } from "bun:test";
import { downloadImage, ImageDownloadError, imageSize, isPrivateIp } from "./image-download.ts";

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(26);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  b[16] = (w >>> 24) & 255; b[17] = (w >>> 16) & 255; b[18] = (w >>> 8) & 255; b[19] = w & 255;
  b[20] = (h >>> 24) & 255; b[21] = (h >>> 16) & 255; b[22] = (h >>> 8) & 255; b[23] = h & 255;
  b[24] = 8; b[25] = 2;
  return b;
}

function fetchReturning(make: () => Response): typeof fetch {
  return (async () => make()) as unknown as typeof fetch;
}

function imgResponse(bytes: Uint8Array, init?: ResponseInit): Response {
  return new Response(new Blob([bytes as BufferSource]), init);
}

const PUBLIC = "http://93.184.216.34/photo.png"; // public IP literal -> no DNS in tests

describe("isPrivateIp", () => {
  test("flags private / loopback / link-local IPv4", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.5", "172.16.0.1", "169.254.1.1", "0.0.0.0"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });
  test("allows public IPv4", () => {
    expect(isPrivateIp("93.184.216.34")).toBe(false);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });
  test("flags IPv6 loopback / ULA / link-local / multicast (full ranges)", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fe90::1")).toBe(true); // fe80::/10 covers fe90, not just fe80
    expect(isPrivateIp("feb0::1")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
    expect(isPrivateIp("fec0::1")).toBe(true); // site-local (deprecated, non-public)
    expect(isPrivateIp("ff02::1")).toBe(true); // multicast
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true); // mapped private (dotted)
    expect(isPrivateIp("::ffff:a00:1")).toBe(true); // mapped private (hex groups)
  });
  test("allows public IPv6", () => {
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });
});

describe("imageSize", () => {
  test("parses PNG dimensions", () => {
    expect(imageSize(png(300, 200))).toEqual({ width: 300, height: 200 });
  });
  test("parses GIF dimensions", () => {
    const b = new Uint8Array(10);
    b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
    b[6] = 0x2c; b[7] = 0x01; // width 300 LE
    b[8] = 0xc8; b[9] = 0x00; // height 200 LE
    expect(imageSize(b)).toEqual({ width: 300, height: 200 });
  });
  test("returns null for non-image bytes", () => {
    expect(imageSize(new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });
});

describe("downloadImage — SSRF guard", () => {
  test("rejects a private IP host before fetching", async () => {
    let called = false;
    const fetchImpl = fetchReturning(() => {
      called = true;
      return imgResponse(png(300, 300));
    });
    await expect(downloadImage("http://10.0.0.1/x.png", { fetchImpl })).rejects.toThrow(/ssrf/);
    expect(called).toBe(false);
  });

  test("rejects a redirect that points at an internal IP", async () => {
    const fetchImpl = fetchReturning(
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/evil.png" } }),
    );
    await expect(downloadImage(PUBLIC, { fetchImpl })).rejects.toThrow(/ssrf/);
  });

  test("rejects a bracketed IPv6 loopback host", async () => {
    const fetchImpl = fetchReturning(() => imgResponse(png(300, 300)));
    await expect(downloadImage("http://[::1]/x.png", { fetchImpl })).rejects.toThrow(/ssrf/);
  });
});

describe("downloadImage — content validation", () => {
  test("accepts a valid PNG and returns hash + dims", async () => {
    const fetchImpl = fetchReturning(() => imgResponse(png(300, 300)));
    const img = await downloadImage(PUBLIC, { fetchImpl });
    expect(img.mime).toBe("image/png");
    expect(img.ext).toBe("png");
    expect(img.width).toBe(300);
    expect(img.hash.length).toBe(32);
  });

  test("rejects SVG", async () => {
    const fetchImpl = fetchReturning(() => new Response("<svg xmlns='..'></svg>"));
    await expect(downloadImage(PUBLIC, { fetchImpl })).rejects.toThrow(ImageDownloadError);
  });

  test("rejects HTML", async () => {
    const fetchImpl = fetchReturning(() => new Response("<!doctype html><html></html>"));
    await expect(downloadImage(PUBLIC, { fetchImpl })).rejects.toThrow(/svg\/html/);
  });

  test("rejects an oversized response", async () => {
    const big = new Uint8Array(500);
    big.set(png(300, 300), 0);
    const fetchImpl = fetchReturning(() => imgResponse(big));
    await expect(downloadImage(PUBLIC, { fetchImpl, maxBytes: 100 })).rejects.toThrow(/too large/);
  });

  test("rejects an image below minimum dimensions", async () => {
    const fetchImpl = fetchReturning(() => imgResponse(png(50, 50)));
    await expect(downloadImage(PUBLIC, { fetchImpl })).rejects.toThrow(/minimum dimensions/);
  });

  test("rejects a non-2xx response", async () => {
    const fetchImpl = fetchReturning(() => new Response("nope", { status: 404 }));
    await expect(downloadImage(PUBLIC, { fetchImpl })).rejects.toThrow(/http 404/);
  });

  test("rejects a truncated image (valid signature, unparseable dimensions)", async () => {
    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG sig only
    const fetchImpl = fetchReturning(() => imgResponse(sig));
    await expect(downloadImage(PUBLIC, { fetchImpl })).rejects.toThrow(/truncated|undeterminable/);
  });
});
