/**
 * Vibe presets (PLAN.md MG8) — the content picks the look. Codex chooses a
 * `vibePresetId` (from this fixed set, mirrored from synth.ts VIBE_PRESETS) plus
 * an `accentColor`; the frontend maps the id to a CSS theme class and applies the
 * accent as a custom property. Pure + framework-free so it's unit-testable.
 */
export const VIBE_PRESET_IDS = [
  "classic-editorial",
  "modern-minimal",
  "vintage-science",
  "retro-tech",
  "zine",
  "mono-serif",
] as const;

export type VibePresetId = (typeof VIBE_PRESET_IDS)[number];

export const DEFAULT_VIBE: VibePresetId = "classic-editorial";
export const DEFAULT_ACCENT = "#9c4a2f";

const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

/** Coerce an arbitrary (model-supplied) id to a KNOWN preset, else the default. */
export function resolveVibePresetId(id: string): VibePresetId {
  return (VIBE_PRESET_IDS as readonly string[]).includes(id) ? (id as VibePresetId) : DEFAULT_VIBE;
}

/** The CSS class that selects the preset's theme variables. */
export function vibeClass(id: string): string {
  return `vibe-${resolveVibePresetId(id)}`;
}

/**
 * Validate the accent before it touches a `style` attribute. The server already
 * enforces `#rrggbb`, but re-validate here so a bad value can never inject CSS.
 */
export function safeAccent(color: string): string {
  return ACCENT_RE.test(color) ? color : DEFAULT_ACCENT;
}
