/**
 * Web vibe helper. The preset list, default accent, and validators are shared
 * (src/shared/vibe.ts) so the server and web agree; this module only adds the
 * web-only id -> CSS-class mapping the renderer needs.
 */
import { resolveVibePresetId } from "../shared/vibe.ts";

export {
  DEFAULT_ACCENT,
  DEFAULT_VIBE,
  resolveVibePresetId,
  safeAccent,
  VIBE_PRESETS,
  type VibePresetId,
} from "../shared/vibe.ts";

/** The CSS class that selects the preset's theme variables. */
export function vibeClass(id: string): string {
  return `vibe-${resolveVibePresetId(id)}`;
}
