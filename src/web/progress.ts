/**
 * Loading-progress helpers (PLAN.md MG11). Pure + DOM-free so they're unit-
 * testable: the map from a completed pipeline stage to the next user-facing
 * status line, and a Server-Sent-Events parser for the `/surprise` stream.
 */

export type SurpriseStage = "pick" | "fetch" | "curate" | "synthesize" | "images" | "persist";

export const INITIAL_STATUS = "Choosing a deep-reading publication…";

// Forward-looking: once a stage COMPLETES, name what happens next.
const NEXT_STATUS: Record<SurpriseStage, string> = {
  pick: "Reading the archive…",
  fetch: "Sorting the deep articles…",
  curate: "Writing the deep-dives… (the slow part)",
  synthesize: "Finding images…",
  images: "Saving to your library…",
  persist: "Almost ready…",
};

export function statusForStage(stage: string): string {
  return NEXT_STATUS[stage as SurpriseStage] ?? "Working…";
}

// The press docket: the high-level deep-dive PHASES, stamped as the matching SSE
// `stage` events land. The per-cluster synthesize/images/persist stages repeat,
// so the docket tracks only the leading phases; "Writing the deep-dives" stays
// active until the run is done (main.ts handles that).
export interface PressStep {
  stage: SurpriseStage;
  label: string;
}
export const PRESS_STEPS: readonly PressStep[] = [
  { stage: "pick", label: "Choosing a publication" },
  { stage: "fetch", label: "Reading the archive" },
  { stage: "curate", label: "Sorting the deep articles" },
  { stage: "synthesize", label: "Writing the deep-dives" },
];

export type StepState = "done" | "active" | "pending";

/**
 * Resolve each docket step's state from the set of COMPLETED stages: completed
 * steps are `done`, the first not-yet-done step is `active`, the rest `pending`.
 */
export function docketStates(completed: readonly string[]): (PressStep & { state: StepState })[] {
  const done = new Set(completed);
  let activeTaken = false;
  return PRESS_STEPS.map((step) => {
    if (done.has(step.stage)) return { ...step, state: "done" };
    if (!activeTaken) {
      activeTaken = true;
      return { ...step, state: "active" };
    }
    return { ...step, state: "pending" };
  });
}

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Parse complete SSE events out of an accumulated buffer. Events are separated
 * by a blank line; returns the parsed events plus the (incomplete) remainder to
 * carry into the next chunk. Multiple `data:` lines join with newlines.
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer;
  let sep = rest.indexOf("\n\n");
  while (sep !== -1) {
    const block = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join("\n") });
    sep = rest.indexOf("\n\n");
  }
  return { events, rest };
}
