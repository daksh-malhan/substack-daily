import { describe, expect, test } from "bun:test";
import { canonicalizeDomain, isSubstackPublicationHost } from "./domains.ts";

describe("canonicalizeDomain", () => {
  test("strips scheme, path, and trailing content", () => {
    expect(canonicalizeDomain("https://foo.substack.com/p/hello")).toBe("foo.substack.com");
  });
  test("strips leading www and lowercases", () => {
    expect(canonicalizeDomain("HTTPS://WWW.Slowboring.com/")).toBe("slowboring.com");
  });
  test("accepts a bare host", () => {
    expect(canonicalizeDomain("astralcodexten.com")).toBe("astralcodexten.com");
  });
  test("strips a port", () => {
    expect(canonicalizeDomain("http://example.com:8080/x")).toBe("example.com");
  });
  test("returns null for non-hosts", () => {
    expect(canonicalizeDomain("")).toBeNull();
    expect(canonicalizeDomain("not a url")).toBeNull();
    expect(canonicalizeDomain("localhost")).toBeNull(); // no dot -> not a domain
  });
});

describe("isSubstackPublicationHost", () => {
  test("accepts a publication subdomain", () => {
    expect(isSubstackPublicationHost("foo.substack.com")).toBe(true);
  });
  test("rejects reserved subdomains and the apex", () => {
    expect(isSubstackPublicationHost("www.substack.com")).toBe(false);
    expect(isSubstackPublicationHost("open.substack.com")).toBe(false);
    expect(isSubstackPublicationHost("substack.com")).toBe(false);
  });
  test("rejects nested or non-substack hosts", () => {
    expect(isSubstackPublicationHost("a.b.substack.com")).toBe(false);
    expect(isSubstackPublicationHost("example.com")).toBe(false);
  });
});
