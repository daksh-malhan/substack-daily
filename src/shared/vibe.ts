/**
 * Vibe presets — the ONE canonical set + accent validation, shared by the server
 * (synth.ts picks/validates the model-supplied id) and the web (render.ts maps
 * id -> CSS class). Both sides validate against this single source so the list
 * and the accent rule can never drift apart.
 */
export const VIBE_PRESETS = [
  "classic-editorial",
  "modern-minimal",
  "vintage-science",
  "retro-tech",
  "zine",
  "mono-serif",
] as const;

export type VibePresetId = (typeof VIBE_PRESETS)[number];

export const DEFAULT_VIBE: VibePresetId = "classic-editorial";
export const DEFAULT_ACCENT = "#9c4a2f";

const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

/** Coerce an arbitrary (model-supplied) id to a KNOWN preset, else the default. */
export function resolveVibePresetId(id: string): VibePresetId {
  return (VIBE_PRESETS as readonly string[]).includes(id) ? (id as VibePresetId) : DEFAULT_VIBE;
}

/**
 * Validate an accent before it touches a `style` attribute / prompt output.
 * A non-`#rrggbb` value can never inject CSS — it falls back to the default.
 */
export function safeAccent(color: string): string {
  return ACCENT_RE.test(color) ? color : DEFAULT_ACCENT;
}
