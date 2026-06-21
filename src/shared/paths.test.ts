import { describe, expect, test } from "bun:test";
import { resolveInVault, slugify, uniqueSlug } from "./paths.ts";

describe("slugify", () => {
  test("lowercases and dashes a normal title", () => {
    expect(slugify("The Intrinsic Perspective")).toBe("the-intrinsic-perspective");
  });

  test("strips unsafe characters and collapses dashes", () => {
    expect(slugify("Works in Progress: Vol. 2 (2024)!!")).toBe("works-in-progress-vol-2-2024");
  });

  test("strips diacritics", () => {
    expect(slugify("Café Society")).toBe("cafe-society");
  });

  test("throws on a name that reduces to nothing", () => {
    expect(() => slugify("///")).toThrow();
    expect(() => slugify("   ")).toThrow();
  });

  test("throws on reserved device names", () => {
    expect(() => slugify("CON")).toThrow();
    expect(() => slugify("nul")).toThrow();
  });
});

describe("uniqueSlug", () => {
  test("appends a numeric suffix on collision", () => {
    const taken = new Set<string>();
    expect(uniqueSlug("Neuroscience", taken)).toBe("neuroscience");
    expect(uniqueSlug("Neuroscience", taken)).toBe("neuroscience-2");
    expect(uniqueSlug("Neuroscience", taken)).toBe("neuroscience-3");
  });

  test("dedupes case-insensitively (macOS filesystem)", () => {
    const taken = new Set<string>();
    expect(uniqueSlug("Theme", taken)).toBe("theme");
    // "THEME" slugifies to "theme" which is already taken -> suffix.
    expect(uniqueSlug("THEME", taken)).toBe("theme-2");
  });
});

describe("resolveInVault", () => {
  const root = "/tmp/vault";

  test("allows a normal nested path", () => {
    expect(resolveInVault(root, "intrinsic/images/a.png")).toBe(
      "/tmp/vault/intrinsic/images/a.png",
    );
  });

  test("allows the root itself", () => {
    expect(resolveInVault(root, ".")).toBe("/tmp/vault");
  });

  test("throws on parent-directory traversal", () => {
    expect(() => resolveInVault(root, "../etc/passwd")).toThrow();
    expect(() => resolveInVault(root, "a/../../b")).toThrow();
  });

  test("throws on an absolute path that escapes the root", () => {
    expect(() => resolveInVault(root, "/etc/passwd")).toThrow();
  });

  test("does not treat a sibling prefix as inside the vault", () => {
    expect(() => resolveInVault("/tmp/vault", "../vault-evil/x")).toThrow();
  });
});
