import { describe, expect, test } from "bun:test";
import {
  hostnameFromHostHeader,
  isJsonContentType,
  isLocalHost,
  isMutatingMethod,
  originIsLocal,
  originMatchesHost,
  securityCheck,
} from "./security.ts";

describe("originMatchesHost — full origin (scheme+host+port)", () => {
  test("exact http same-origin matches; cross-scheme/port/host do not", () => {
    expect(originMatchesHost("http://127.0.0.1:4321", "127.0.0.1:4321")).toBe(true);
    expect(originMatchesHost("https://127.0.0.1:4321", "127.0.0.1:4321")).toBe(false); // cross-scheme
    expect(originMatchesHost("http://127.0.0.1:9999", "127.0.0.1:4321")).toBe(false); // cross-port
    expect(originMatchesHost("http://evil.example.com", "127.0.0.1:4321")).toBe(false);
  });
});

describe("isJsonContentType — exact media type", () => {
  test("accepts application/json with params, rejects substring spoofs", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("text/plain; x=application/json")).toBe(false);
    expect(isJsonContentType("application/json-patch+json")).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
  });
});

const LOCAL_HOST = "127.0.0.1:4321";
function secReq(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:4321/x", { method: "GET", headers: { host: LOCAL_HOST, ...headers } });
}

describe("securityCheck — Sec-Fetch-Site", () => {
  test("blocks cross-site asset reads even without an Origin", () => {
    expect(securityCheck(secReq({ "sec-fetch-site": "cross-site" }), "asset")?.status).toBe(403);
    expect(securityCheck(secReq({ "sec-fetch-site": "same-site" }), "asset")?.status).toBe(403);
  });
  test("allows same-origin and direct navigation (none / absent)", () => {
    expect(securityCheck(secReq({ "sec-fetch-site": "same-origin" }), "asset")).toBeNull();
    expect(securityCheck(secReq({ "sec-fetch-site": "none" }), "asset")).toBeNull();
    expect(securityCheck(secReq({}), "asset")).toBeNull(); // curl / old browser
  });
});

describe("hostnameFromHostHeader", () => {
  test("strips the port", () => {
    expect(hostnameFromHostHeader("127.0.0.1:4321")).toBe("127.0.0.1");
    expect(hostnameFromHostHeader("localhost")).toBe("localhost");
  });
  test("handles ipv6 literals", () => {
    expect(hostnameFromHostHeader("[::1]:4321")).toBe("[::1]");
  });
  test("null for missing header", () => {
    expect(hostnameFromHostHeader(null)).toBeNull();
  });
});

describe("isLocalHost", () => {
  test("accepts loopback names", () => {
    expect(isLocalHost("127.0.0.1:4321")).toBe(true);
    expect(isLocalHost("localhost:4321")).toBe(true);
    expect(isLocalHost("[::1]")).toBe(true);
  });
  test("rejects non-local and missing hosts", () => {
    expect(isLocalHost("evil.example.com")).toBe(false);
    expect(isLocalHost("192.168.1.10:4321")).toBe(false);
    expect(isLocalHost(null)).toBe(false);
  });
});

describe("originIsLocal", () => {
  test("accepts a loopback origin", () => {
    expect(originIsLocal("http://127.0.0.1:4321")).toBe(true);
    expect(originIsLocal("http://localhost:4321")).toBe(true);
  });
  test("rejects cross-site / malformed / missing origins", () => {
    expect(originIsLocal("https://evil.example.com")).toBe(false);
    expect(originIsLocal("not-a-url")).toBe(false);
    expect(originIsLocal(null)).toBe(false);
  });
});

describe("isMutatingMethod", () => {
  test("classifies methods", () => {
    expect(isMutatingMethod("GET")).toBe(false);
    expect(isMutatingMethod("HEAD")).toBe(false);
    expect(isMutatingMethod("POST")).toBe(true);
    expect(isMutatingMethod("DELETE")).toBe(true);
  });
});

describe("originMatchesHost (exact same-origin)", () => {
  test("matches identical host:port", () => {
    expect(originMatchesHost("http://127.0.0.1:4321", "127.0.0.1:4321")).toBe(true);
  });
  test("rejects a different port on the same loopback host", () => {
    expect(originMatchesHost("http://127.0.0.1:9999", "127.0.0.1:4321")).toBe(false);
  });
  test("rejects a cross-site origin and malformed/missing values", () => {
    expect(originMatchesHost("https://evil.example.com", "127.0.0.1:4321")).toBe(false);
    expect(originMatchesHost("not-a-url", "127.0.0.1:4321")).toBe(false);
    expect(originMatchesHost(null, "127.0.0.1:4321")).toBe(false);
  });
});

function req(headers: Record<string, string>, method = "POST"): Request {
  return new Request("http://127.0.0.1:4321/surprise", { method, headers });
}

describe("securityCheck — mutating", () => {
  test("passes a valid exact same-origin JSON mutation", () => {
    const r = req({
      host: "127.0.0.1:4321",
      origin: "http://127.0.0.1:4321",
      "content-type": "application/json",
    });
    expect(securityCheck(r, "mutating")).toBeNull();
  });

  test("rejects a non-local Host (rebinding)", () => {
    const r = req({ host: "evil.example.com", "content-type": "application/json" });
    expect(securityCheck(r, "mutating")?.status).toBe(403);
  });

  test("rejects a cross-site Origin (CSRF)", () => {
    const r = req({
      host: "127.0.0.1:4321",
      origin: "https://evil.example.com",
      "content-type": "application/json",
    });
    expect(securityCheck(r, "mutating")?.status).toBe(403);
  });

  test("rejects a cross-PORT loopback Origin (exact same-origin)", () => {
    const r = req({
      host: "127.0.0.1:4321",
      origin: "http://127.0.0.1:9999",
      "content-type": "application/json",
    });
    expect(securityCheck(r, "mutating")?.status).toBe(403);
  });

  test("rejects a missing Origin on a mutation", () => {
    const r = req({ host: "127.0.0.1:4321", "content-type": "application/json" });
    expect(securityCheck(r, "mutating")?.status).toBe(403);
  });

  test("rejects a mutation with the wrong content-type", () => {
    const r = req({
      host: "127.0.0.1:4321",
      origin: "http://127.0.0.1:4321",
      "content-type": "text/plain",
    });
    expect(securityCheck(r, "mutating")?.status).toBe(415);
  });
});

describe("securityCheck — asset", () => {
  test("rejects a cross-origin asset read (exfiltration defense)", () => {
    const r = req({ host: "127.0.0.1:4321", origin: "https://evil.example.com" }, "GET");
    expect(securityCheck(r, "asset")?.status).toBe(403);
  });
  test("allows a same-origin asset read", () => {
    const r = req({ host: "127.0.0.1:4321", origin: "http://127.0.0.1:4321" }, "GET");
    expect(securityCheck(r, "asset")).toBeNull();
  });
  test("allows an asset request with no Origin (top-level navigation)", () => {
    const r = req({ host: "127.0.0.1:4321" }, "GET");
    expect(securityCheck(r, "asset")).toBeNull();
  });
  test("rejects a non-local Host on an asset request", () => {
    const r = req({ host: "evil.example.com" }, "GET");
    expect(securityCheck(r, "asset")?.status).toBe(403);
  });
});

describe("securityCheck — static", () => {
  test("local request needs no Origin/JSON", () => {
    const r = req({ host: "127.0.0.1:4321" }, "GET");
    expect(securityCheck(r, "static")).toBeNull();
  });
});
