import { describe, expect, test } from "bun:test";
import { canonical, normalize, toPlainText } from "./text.ts";

describe("toPlainText", () => {
  test("strips tags and decodes entities", () => {
    expect(toPlainText("<p>Tom &amp; Jerry</p>")).toBe("Tom & Jerry");
  });

  test("drops script/style content", () => {
    const html = "<div>hi<script>alert('x')</script><style>.a{}</style> there</div>";
    expect(toPlainText(html)).toBe("hi there");
  });

  test("decodes numeric and named entities", () => {
    expect(toPlainText("a &lt;b&gt; &#38; c &nbsp;d")).toContain("a <b> & c");
  });

  test("returns empty string unchanged", () => {
    expect(toPlainText("")).toBe("");
  });
});

describe("normalize", () => {
  test("folds smart quotes to ascii", () => {
    expect(normalize("“hello” ‘world’")).toBe(`"hello" 'world'`);
  });

  test("folds dashes and ellipsis", () => {
    expect(normalize("a — b – c …")).toBe("a - b - c ...");
  });

  test("collapses all whitespace runs and trims", () => {
    expect(normalize("  a\t\t b\n\n  c  ")).toBe("a b c");
  });

  test("normalizes non-breaking space to a regular space", () => {
    expect(normalize("a b")).toBe("a b");
  });

  test("is idempotent", () => {
    const once = normalize("“fancy—quote”");
    expect(normalize(once)).toBe(once);
  });

  test("NFC-normalizes decomposed characters", () => {
    const decomposed = "café"; // cafe + combining acute
    const composed = "café"; // café
    expect(normalize(decomposed)).toBe(normalize(composed));
  });
});

describe("canonical", () => {
  test("equates an html source excerpt with the model's plain rewrite", () => {
    const source = "<p>He said “Yes—really”&nbsp;today.</p>";
    const excerpt = 'He said "Yes-really" today.';
    expect(canonical(source).includes(canonical(excerpt))).toBe(true);
  });
});
