/**
 * Pure layout core (PLAN.md MG9, dynamic-layout upgrade). The DOM-free,
 * unit-testable half of the pretext article-body layout. Text flows around an
 * image treated as a MOVABLE OBSTACLE positioned anywhere in the column: for
 * each line band we compute the horizontal segments NOT covered by the obstacle
 * (a left gap and/or a right gap) and fill them left-to-right, so prose wraps
 * around both sides of the image — and, because the image is draggable, the
 * whole thing recomputes live as it moves (see article-layout.ts).
 *
 * The flow takes a `FlowEngine` (the text-measuring line breaker) as a parameter
 * so the control logic is testable with a deterministic fake; the real driver
 * injects @chenglou/pretext.
 */

/**
 * Reflow debounce window (ms) for RESIZE (PLAN.md MG9's 100–250ms settle band):
 * resize recomputes once, this long after the last event. Dragging reflows live
 * (rAF-throttled), not debounced.
 */
export const REFLOW_DEBOUNCE_MS = 150;

/** Smallest usable text segment beside the obstacle; thinner slivers are skipped. */
export const MIN_SEGMENT_WIDTH = 48;

/** Trailing debounce: coalesces a burst of calls into one call `ms` after the last. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: A): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return wrapped;
}

/**
 * Coalesce rapid calls onto one scheduled callback (the live-drag analogue of
 * `debounce`, for animation frames). The scheduler is injected so it's testable
 * with a fake; the driver passes requestAnimationFrame/cancelAnimationFrame.
 */
export function rafThrottle(
  schedule: (cb: () => void) => number,
  cancel: (id: number) => void,
  fn: () => void,
): { call: () => void; cancel: () => void } {
  let id = 0;
  return {
    call: () => {
      if (id) return;
      id = schedule(() => {
        id = 0;
        fn();
      });
    },
    cancel: () => {
      if (id) {
        cancel(id);
        id = 0;
      }
    },
  };
}

export const IMAGE_WIDTH_RATIO = 0.4;
export const IMAGE_MIN_WIDTH = 120;
export const IMAGE_MAX_WIDTH = 360;
export const IMAGE_ASPECT = 0.72; // height / width

/**
 * Pick the plate's pixel size for a column. Targets ~40% of the column, clamped
 * to [120, 360]px, but NEVER wider than 80% of the column — so on a narrow column
 * the image can't exceed (or fill) the width and leave no room for text.
 */
export function imageSizeFor(columnWidth: number): { width: number; height: number } {
  const cap = Math.max(40, Math.floor(columnWidth * 0.8));
  const ideal = Math.floor(columnWidth * IMAGE_WIDTH_RATIO);
  const clamped = Math.min(IMAGE_MAX_WIDTH, Math.max(IMAGE_MIN_WIDTH, ideal));
  const width = Math.min(clamped, cap);
  return { width, height: Math.round(width * IMAGE_ASPECT) };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Axis-aligned overlap (touching edges do NOT count as overlap). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Clamp the obstacle so it stays fully inside the column (used while dragging). */
export function clampObstacle(ob: Rect, columnWidth: number, columnHeight: number): Rect {
  const x = Math.max(0, Math.min(ob.x, Math.max(0, columnWidth - ob.width)));
  const y = Math.max(0, Math.min(ob.y, Math.max(0, columnHeight - ob.height)));
  return { x, y, width: ob.width, height: ob.height };
}

export interface LineBox {
  text: string;
  top: number;
  left: number;
  width: number;
}

/**
 * A line breaker over prepared text. `next` returns the next line that fits in
 * `maxWidth` and the cursor after it, or null when the text is exhausted.
 * `equal` detects a no-progress cursor (so the loop can never spin).
 */
export interface FlowEngine<C> {
  start: C;
  next: (cursor: C, maxWidth: number) => { end: C; line: string } | null;
  equal: (a: C, b: C) => boolean;
}

export interface FlowParams {
  /** Full content width of the column. */
  totalWidth: number;
  /** The image obstacle, positioned anywhere in the column. */
  obstacle: Rect;
  /** Horizontal gap kept between text and the obstacle. */
  gap: number;
  lineHeight: number;
  /** Thinnest segment worth filling (default MIN_SEGMENT_WIDTH). */
  minSegmentWidth?: number;
  /** Hard cap so a pathological engine can never run away. */
  maxLines?: number;
}

/**
 * The horizontal text segments available on the line band starting at `top`:
 * the full width if the band misses the obstacle, else the left gap and/or right
 * gap around it (each only if at least `minSegmentWidth` wide). A segment's edge
 * stops `gap` short of the obstacle, so lines placed in it can never overlap it.
 */
export function availableSegments(top: number, p: FlowParams): { x: number; width: number }[] {
  const minSeg = p.minSegmentWidth ?? MIN_SEGMENT_WIDTH;
  const ob = p.obstacle;
  const bottom = top + p.lineHeight;
  const hitsObstacle = ob.width > 0 && ob.height > 0 && bottom > ob.y && top < ob.y + ob.height;
  if (!hitsObstacle) return [{ x: 0, width: p.totalWidth }];

  const segments: { x: number; width: number }[] = [];
  const leftWidth = ob.x - p.gap;
  if (leftWidth >= minSeg) segments.push({ x: 0, width: leftWidth });
  const rightX = ob.x + ob.width + p.gap;
  const rightWidth = p.totalWidth - rightX;
  if (rightWidth >= minSeg) segments.push({ x: rightX, width: rightWidth });
  return segments;
}

/**
 * Flow `engine`'s lines down the column, wrapping around the obstacle. Each line
 * band may produce up to two boxes (left of / right of the obstacle); bands the
 * obstacle blocks entirely produce none and the flow steps past them. Lines can
 * never overlap the obstacle — a property the tests assert via `rectsOverlap`.
 */
export function flowAround<C>(engine: FlowEngine<C>, p: FlowParams): LineBox[] {
  const boxes: LineBox[] = [];
  let cursor = engine.start;
  let y = 0;
  const cap = p.maxLines ?? 5000;
  for (let i = 0; i < cap; i++) {
    let exhausted = false;
    for (const segment of availableSegments(y, p)) {
      if (segment.width <= 0) continue;
      const result = engine.next(cursor, segment.width);
      if (!result) {
        exhausted = true;
        break;
      }
      if (engine.equal(result.end, cursor)) continue; // word won't fit here; try next segment/row
      boxes.push({ text: result.line, top: y, left: segment.x, width: segment.width });
      cursor = result.end;
    }
    if (exhausted) break;
    y += p.lineHeight;
  }
  return boxes;
}

/** Total laid-out height: the lowest line bottom or the obstacle bottom. */
export function flowHeight(boxes: LineBox[], p: FlowParams): number {
  const textBottom = boxes.reduce((max, b) => Math.max(max, b.top + p.lineHeight), 0);
  return Math.max(textBottom, p.obstacle.y + p.obstacle.height);
}
