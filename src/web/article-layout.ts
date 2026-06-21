/**
 * pretext article-body layout — dynamic version (PLAN.md MG9). For each rendered
 * section that has BOTH a figure and prose, the image becomes a DRAGGABLE plate
 * and the prose flows around it on both sides via @chenglou/pretext. Dragging the
 * image reflows the text LIVE (rAF-throttled); resizing reflows through a
 * debounced ResizeObserver. The flow control + geometry live in layout.ts (pure,
 * unit-tested); this file measures real fonts, calls pretext, drives the DOM, and
 * handles pointer dragging.
 *
 * Image-less sections keep MG8's plain paragraph; a section whose image fails to
 * load degrades to plain prose so the layout never breaks.
 */
import {
  type LayoutCursor,
  layoutNextLineRange,
  materializeLineRange,
  prepareWithSegments,
} from "@chenglou/pretext";
import {
  clampObstacle,
  debounce,
  type FlowEngine,
  type FlowParams,
  flowAround,
  flowHeight,
  imageSizeFor,
  rafThrottle,
  type Rect,
  REFLOW_DEBOUNCE_MS,
} from "./layout.ts";

interface Flowable {
  flowEl: HTMLElement;
  img: HTMLImageElement;
  prose: string;
  obstacle: Rect;
  plain: boolean;
}

const GAP = 22;

/** Replace each flowable section's figure+prose with a `.mag-flow` host + draggable image. */
function collect(article: HTMLElement): Flowable[] {
  const out: Flowable[] = [];
  for (const section of article.querySelectorAll<HTMLElement>(".mag-section")) {
    const figure = section.querySelector<HTMLElement>(".mag-figure");
    const prose = section.querySelector<HTMLElement>(".mag-prose");
    const srcImg = figure?.querySelector("img");
    const text = prose?.textContent?.trim();
    if (!figure || !prose || !srcImg || !text) continue;

    const flowEl = document.createElement("div");
    flowEl.className = "mag-flow";
    section.insertBefore(flowEl, figure);
    figure.remove();
    prose.remove();

    const img = document.createElement("img");
    img.className = "mag-flow-img";
    img.src = srcImg.getAttribute("src") ?? "";
    img.alt = srcImg.getAttribute("alt") ?? "";
    img.loading = "lazy";
    img.draggable = false;
    img.title = "drag me — the text reflows around the image";
    flowEl.appendChild(img);

    out.push({ flowEl, img, prose: text, obstacle: { x: 0, y: 0, width: 0, height: 0 }, plain: false });
  }
  return out;
}

function renderPlain(f: Flowable): void {
  f.flowEl.replaceChildren();
  f.flowEl.style.height = "";
  const p = document.createElement("p");
  p.className = "mag-prose";
  p.textContent = f.prose;
  f.flowEl.appendChild(p);
}

/** Measure the host's rendered font so pretext's widths match what the browser draws. */
function measure(host: HTMLElement): { font: string; lineHeight: number } {
  const probe = document.createElement("div");
  probe.className = "mag-flow-line";
  probe.style.visibility = "hidden";
  probe.textContent = "x";
  host.appendChild(probe);
  const cs = getComputedStyle(probe);
  const fontSize = parseFloat(cs.fontSize) || 16;
  const font = `${cs.fontSize} ${cs.fontFamily}`;
  let lineHeight = parseFloat(cs.lineHeight);
  if (!Number.isFinite(lineHeight)) lineHeight = fontSize * 1.5;
  host.removeChild(probe);
  return { font, lineHeight };
}

function makeEngine(prose: string, font: string): FlowEngine<LayoutCursor> {
  const prepared = prepareWithSegments(prose, font);
  return {
    start: { segmentIndex: 0, graphemeIndex: 0 },
    next: (cursor, maxWidth) => {
      const range = layoutNextLineRange(prepared, cursor, maxWidth);
      return range ? { end: range.end, line: materializeLineRange(prepared, range).text } : null;
    },
    equal: (a, b) => a.segmentIndex === b.segmentIndex && a.graphemeIndex === b.graphemeIndex,
  };
}

/** Re-flow one section against its current obstacle. Keeps the (draggable) image element. */
function relayout(f: Flowable): void {
  if (f.plain) {
    renderPlain(f);
    return;
  }
  const width = f.flowEl.clientWidth;
  if (width <= 0) return;

  const { font, lineHeight } = measure(f.flowEl);
  const params: FlowParams = { totalWidth: width, obstacle: f.obstacle, gap: GAP, lineHeight };
  const boxes = flowAround(makeEngine(f.prose, font), params);

  // Reposition the persistent image (so an in-progress drag is never interrupted).
  f.img.style.width = `${f.obstacle.width}px`;
  f.img.style.height = `${f.obstacle.height}px`;
  f.img.style.left = `${f.obstacle.x}px`;
  f.img.style.top = `${f.obstacle.y}px`;

  // Replace only the line elements (cheap; the image + its drag handlers persist).
  for (const old of f.flowEl.querySelectorAll(".mag-flow-line")) old.remove();
  for (const box of boxes) {
    const line = document.createElement("div");
    line.className = "mag-flow-line";
    line.textContent = box.text;
    line.style.top = `${box.top}px`;
    line.style.left = `${box.left}px`;
    line.style.width = `${box.width}px`;
    f.flowEl.appendChild(line);
  }
  f.flowEl.style.height = `${flowHeight(boxes, params)}px`;
}

/** Size/clamp the obstacle for the current column width, then re-flow. */
function relayoutResized(f: Flowable): void {
  if (f.plain) {
    renderPlain(f);
    return;
  }
  const width = f.flowEl.clientWidth;
  if (width <= 0) return;
  const size = imageSizeFor(width);
  // First layout: park the plate top-right; later layouts keep the dragged spot, re-clamped.
  const first = f.obstacle.width === 0;
  const desired: Rect = first
    ? { x: Math.max(0, width - size.width), y: 0, width: size.width, height: size.height }
    : { x: f.obstacle.x, y: f.obstacle.y, width: size.width, height: size.height };
  f.obstacle = clampObstacle(desired, width, Math.max(desired.height, 1_000_000));
  relayout(f);
}

/**
 * Wire pointer dragging on a section's image; live (rAF-throttled) reflow while
 * moving. Move/up listeners live on `window` (not just the image) so the drag
 * survives the pointer leaving the image or losing capture; `lostpointercapture`
 * also ends the drag. Returns a cleanup that cancels any pending frame and
 * detaches every listener.
 */
function makeDraggable(f: Flowable): () => void {
  let dragging = false;
  let activeId: number | null = null; // the one pointer that owns the drag
  let grabX = 0;
  let grabY = 0;
  const throttle = rafThrottle(
    (cb) => requestAnimationFrame(cb),
    (id) => cancelAnimationFrame(id),
    () => relayout(f),
  );

  const onMove = (event: PointerEvent): void => {
    if (!dragging || event.pointerId !== activeId) return;
    const rect = f.flowEl.getBoundingClientRect();
    const next: Rect = {
      x: event.clientX - rect.left - grabX,
      y: event.clientY - rect.top - grabY,
      width: f.obstacle.width,
      height: f.obstacle.height,
    };
    f.obstacle = clampObstacle(next, f.flowEl.clientWidth, Math.max(f.flowEl.clientHeight, next.height));
    throttle.call();
  };

  const detachWindow = (): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onEnd);
    window.removeEventListener("pointercancel", onEnd);
  };

  function onEnd(event: PointerEvent): void {
    if (!dragging || event.pointerId !== activeId) return;
    dragging = false;
    activeId = null;
    try {
      f.img.releasePointerCapture(event.pointerId);
    } catch {
      // capture may not have been set; nothing to release
    }
    f.img.classList.remove("dragging");
    detachWindow();
    throttle.cancel(); // drop any frame queued mid-drag before the final settle
    relayout(f);
  }

  const onDown = (event: PointerEvent): void => {
    if (dragging) return; // a drag already owns a pointer; ignore secondary pointers
    dragging = true;
    activeId = event.pointerId;
    try {
      f.img.setPointerCapture(event.pointerId);
    } catch {
      // no active pointer (e.g. synthetic event) — window listeners still drive it
    }
    f.img.classList.add("dragging");
    const rect = f.flowEl.getBoundingClientRect();
    grabX = event.clientX - rect.left - f.obstacle.x;
    grabY = event.clientY - rect.top - f.obstacle.y;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    event.preventDefault();
  };

  f.img.addEventListener("pointerdown", onDown);
  f.img.addEventListener("lostpointercapture", onEnd as EventListener);

  return () => {
    dragging = false;
    activeId = null;
    throttle.cancel();
    detachWindow();
    f.img.removeEventListener("pointerdown", onDown);
    f.img.removeEventListener("lostpointercapture", onEnd as EventListener);
  };
}

/**
 * Lay out an article's flowable sections, make each image draggable (live reflow),
 * and reflow on resize (debounced). Returns a disposer that stops observing — call
 * it before re-rendering a new magazine. Only WIDTH changes trigger a resize
 * reflow, so the height changes our own layout makes can't loop the observer.
 */
export function layoutArticle(article: HTMLElement): () => void {
  const flowables = collect(article);
  const cleanups: (() => void)[] = [];
  for (const f of flowables) {
    const onImgError = (): void => {
      f.plain = true; // a broken image -> this section becomes plain prose
      renderPlain(f);
    };
    f.img.addEventListener("error", onImgError);
    const detachDrag = makeDraggable(f);
    cleanups.push(() => {
      f.img.removeEventListener("error", onImgError); // a late failure can't touch a retired layout
      detachDrag();
    });
    relayoutResized(f);
  }

  let lastWidth = article.clientWidth;
  const onResize = debounce(() => {
    for (const f of flowables) relayoutResized(f);
  }, REFLOW_DEBOUNCE_MS);
  const observer = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? article.clientWidth;
    if (Math.abs(width - lastWidth) < 1) return; // ignore our own height-only changes
    lastWidth = width;
    onResize();
  });
  observer.observe(article);

  return () => {
    observer.disconnect();
    onResize.cancel();
    for (const cleanup of cleanups) cleanup();
  };
}
