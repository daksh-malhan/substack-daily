import { describe, expect, test } from "bun:test";
import {
  availableSegments,
  clampObstacle,
  debounce,
  flowAround,
  flowHeight,
  type FlowEngine,
  type FlowParams,
  imageSizeFor,
  type LineBox,
  rafThrottle,
  type Rect,
  rectsOverlap,
  REFLOW_DEBOUNCE_MS,
} from "./layout.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic line breaker: emits `count` lines regardless of width. */
function fakeEngine(count: number): FlowEngine<number> {
  return {
    start: 0,
    next: (cursor) => (cursor >= count ? null : { end: cursor + 1, line: `L${cursor}` }),
    equal: (a, b) => a === b,
  };
}

function boxRect(box: LineBox, lineHeight: number): Rect {
  return { x: box.left, y: box.top, width: box.width, height: lineHeight };
}

describe("debounce", () => {
  test("coalesces a burst into a single trailing call with the last args", async () => {
    let calls = 0;
    let last = -1;
    const d = debounce((n: number) => { calls++; last = n; }, 30);
    d(1); d(2); d(3);
    expect(calls).toBe(0);
    await sleep(60);
    expect(calls).toBe(1);
    expect(last).toBe(3);
  });

  test("cancel() prevents a pending call", async () => {
    let calls = 0;
    const d = debounce(() => { calls++; }, 30);
    d();
    d.cancel();
    await sleep(60);
    expect(calls).toBe(0);
  });

  test("the reflow window sits inside MG9's 100–250ms settle band", () => {
    expect(REFLOW_DEBOUNCE_MS).toBeGreaterThanOrEqual(100);
    expect(REFLOW_DEBOUNCE_MS).toBeLessThanOrEqual(250);
  });

  test("settles 100–250ms after the LAST of a staggered burst (measured)", async () => {
    let firedAt = 0;
    const d = debounce(() => { firedAt = Date.now(); }, REFLOW_DEBOUNCE_MS);
    d();
    await sleep(50); d();
    await sleep(50); d();
    const lastEventAt = Date.now();
    expect(firedAt).toBe(0);
    await sleep(REFLOW_DEBOUNCE_MS + 120);
    const settleMs = firedAt - lastEventAt;
    expect(firedAt).toBeGreaterThan(0);
    expect(settleMs).toBeGreaterThanOrEqual(100);
    expect(settleMs).toBeLessThanOrEqual(250);
  });
});

describe("rafThrottle", () => {
  test("coalesces calls onto one scheduled frame, then can be re-armed", () => {
    let pending: (() => void) | null = null;
    let scheduled = 0;
    let ran = 0;
    const t = rafThrottle(
      (cb) => { scheduled++; pending = cb; return scheduled; },
      () => { pending = null; },
      () => { ran++; },
    );
    t.call(); t.call(); t.call();
    expect(scheduled).toBe(1); // three calls, one frame
    pending!(); // the frame fires
    expect(ran).toBe(1);
    t.call(); // re-armed after firing
    expect(scheduled).toBe(2);
  });

  test("cancel() drops a pending frame so it never runs", () => {
    let pending: (() => void) | null = null;
    let ran = 0;
    const t = rafThrottle((cb) => { pending = cb; return 7; }, () => { pending = null; }, () => { ran++; });
    t.call();
    t.cancel();
    expect(pending).toBeNull();
    expect(ran).toBe(0);
  });
});

describe("imageSizeFor", () => {
  test("targets ~40% of the column, clamped to [120,360]", () => {
    expect(imageSizeFor(1101).width).toBe(360); // 40% = 440 -> capped at 360
    expect(imageSizeFor(700).width).toBe(280); // 40% = 280, within range
  });
  test("never wider than 80% of a narrow column (no overflow)", () => {
    for (const col of [320, 200, 140, 90, 50]) {
      const { width, height } = imageSizeFor(col);
      expect(width).toBeLessThanOrEqual(Math.floor(col * 0.8));
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
    }
  });
});

describe("rectsOverlap", () => {
  test("detects overlap and treats touching edges as non-overlapping", () => {
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 20, width: 10, height: 10 })).toBe(false);
  });
});

describe("clampObstacle", () => {
  test("keeps the obstacle fully inside the column", () => {
    expect(clampObstacle({ x: -50, y: -50, width: 100, height: 80 }, 600, 1000)).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    expect(clampObstacle({ x: 900, y: 2000, width: 100, height: 80 }, 600, 1000)).toEqual({ x: 500, y: 920, width: 100, height: 80 });
    expect(clampObstacle({ x: 200, y: 300, width: 100, height: 80 }, 600, 1000)).toEqual({ x: 200, y: 300, width: 100, height: 80 });
  });
});

describe("availableSegments", () => {
  const p: FlowParams = { totalWidth: 800, obstacle: { x: 300, y: 100, width: 200, height: 150 }, gap: 20, lineHeight: 24 };

  test("bands that miss the obstacle get the full width", () => {
    expect(availableSegments(0, p)).toEqual([{ x: 0, width: 800 }]); // above the obstacle
    expect(availableSegments(260, p)).toEqual([{ x: 0, width: 800 }]); // below it
  });

  test("bands level with the obstacle split into left + right gaps", () => {
    // left gap: [0, 300-20]=280 ; right gap: [300+200+20=520, 800] = 280
    expect(availableSegments(120, p)).toEqual([
      { x: 0, width: 280 },
      { x: 520, width: 280 },
    ]);
  });

  test("a gap thinner than minSegmentWidth is dropped", () => {
    const edge: FlowParams = { ...p, obstacle: { x: 30, y: 100, width: 200, height: 150 } }; // left gap = 10 < 48
    const segs = availableSegments(120, edge);
    expect(segs.length).toBe(1); // only the right gap survives
    expect(segs[0]!.x).toBe(250);
  });
});

describe("flowAround", () => {
  // Obstacle at left, center, right, top, bottom — text must clear it everywhere.
  const base = { totalWidth: 760, gap: 20, lineHeight: 26 };
  const placements: { name: string; obstacle: Rect }[] = [
    { name: "center", obstacle: { x: 280, y: 120, width: 220, height: 180 } },
    { name: "left", obstacle: { x: 0, y: 60, width: 240, height: 160 } },
    { name: "right", obstacle: { x: 520, y: 0, width: 240, height: 160 } },
    { name: "top", obstacle: { x: 250, y: 0, width: 240, height: 130 } },
    { name: "low", obstacle: { x: 250, y: 300, width: 240, height: 150 } },
  ];

  for (const { name, obstacle } of placements) {
    test(`obstacle ${name}: no line overlaps the image`, () => {
      const p: FlowParams = { ...base, obstacle };
      const boxes = flowAround(fakeEngine(60), p);
      expect(boxes.length).toBeGreaterThan(0);
      for (const box of boxes) {
        expect(rectsOverlap(boxRect(box, p.lineHeight), obstacle)).toBe(false);
      }
    });
  }

  test("a centered obstacle produces text on BOTH sides of it", () => {
    const p: FlowParams = { ...base, obstacle: placements[0]!.obstacle };
    const boxes = flowAround(fakeEngine(60), p);
    const ob = p.obstacle;
    const besideBand = (b: LineBox) => b.top + p.lineHeight > ob.y && b.top < ob.y + ob.height;
    const beside = boxes.filter(besideBand);
    expect(beside.some((b) => b.left < ob.x)).toBe(true); // left of the image
    expect(beside.some((b) => b.left >= ob.x + ob.width)).toBe(true); // right of the image
  });

  test("lines above and below a centered obstacle span the full width", () => {
    const p: FlowParams = { ...base, obstacle: placements[0]!.obstacle };
    const boxes = flowAround(fakeEngine(80), p);
    const ob = p.obstacle;
    expect(boxes.some((b) => b.top + p.lineHeight <= ob.y && b.width === p.totalWidth)).toBe(true);
    expect(boxes.some((b) => b.top >= ob.y + ob.height && b.width === p.totalWidth)).toBe(true);
  });

  test("terminates on a no-progress engine instead of spinning", () => {
    const stuck: FlowEngine<number> = { start: 0, next: () => ({ end: 0, line: "x" }), equal: (a, b) => a === b };
    const boxes = flowAround(stuck, { ...base, obstacle: placements[2]!.obstacle, maxLines: 100 });
    // no-progress segments are skipped and y still advances to the cap (no hang)
    expect(boxes.length).toBeLessThanOrEqual(100);
  });

  test("respects the maxLines cap", () => {
    const boxes = flowAround(fakeEngine(10_000), { ...base, obstacle: placements[0]!.obstacle, maxLines: 12 });
    // up to two boxes per band beside the obstacle, so cap bands * 2 is the ceiling
    expect(boxes.length).toBeLessThanOrEqual(24);
    expect(boxes.every((b) => b.top <= 12 * base.lineHeight)).toBe(true);
  });

  test("flowHeight is at least the obstacle bottom even with little text", () => {
    const p: FlowParams = { ...base, obstacle: { x: 100, y: 200, width: 200, height: 220 } };
    expect(flowHeight(flowAround(fakeEngine(1), p), p)).toBe(420);
  });
});
