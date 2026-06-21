/**
 * Canonical plain-text + normalization pipeline (PLAN.md MG0, addresses review #3).
 *
 * One source of truth used by BOTH the content fetcher and the excerpt
 * anti-fabrication check, so they always compare like-for-like:
 *   - `toPlainText(html)` strips markup to inert text and decodes entities.
 *   - `normalize(text)` NFC-normalizes, folds smart punctuation, collapses whitespace.
 *   - `canonical(s)` = normalize(toPlainText(s)) — the form used for substring checks.
 */
import { parse } from "node-html-parser";

/** Strip HTML to inert, entity-decoded plain text. Safe on already-plain input. */
export function toPlainText(html: string): string {
  if (html === "") return "";
  const root = parse(html, {
    blockTextElements: { script: false, style: false, noscript: false },
  });
  // `.text` returns the concatenated, entity-decoded text of all text nodes,
  // with <script>/<style>/<noscript> contents dropped per the options above.
  return root.text;
}

const SMART_PUNCTUATION: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"], // ‘ ’ ‚ ‛ ′ -> '
  [/[“”„‟″]/g, '"'], // “ ” „ ‟ ″ -> "
  [/[–—―]/g, "-"], // – — ― -> -
  [/[…]/g, "..."], // … -> ...
  [/[   ]/g, " "], // non-breaking / figure / narrow no-break spaces -> space
];

/**
 * Unicode-normalize (NFC), fold smart punctuation to ASCII equivalents, and
 * collapse all runs of whitespace to single spaces. Idempotent.
 */
export function normalize(text: string): string {
  let out = text.normalize("NFC");
  for (const [pattern, replacement] of SMART_PUNCTUATION) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, " ").trim();
}

/** The canonical comparable form: decode/strip, then normalize. */
export function canonical(input: string): string {
  return normalize(toPlainText(input));
}
