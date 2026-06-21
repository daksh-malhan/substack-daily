/**
 * pretext spike (PLAN.md MG1): prove @chenglou/pretext can flow prose around a
 * floated image, line by line, reflowing on resize — BEFORE the magazine schema
 * is locked. Each line is laid out with its own maxWidth: narrow while beside the
 * image, full-width once past the image's bottom edge. Lines are absolutely
 * positioned at a computed y, so there is never any overlap with the image.
 */
import {
  type LayoutCursor,
  layoutNextLineRange,
  materializeLineRange,
  prepareWithSegments,
} from "@chenglou/pretext";

// Must match `.spike` CSS font exactly (px size + family) for correct measurement.
const FONT = "16px Georgia, serif";
const LINE_HEIGHT = 26;
const IMG_HEIGHT = 160;
const GAP = 20;

const SAMPLE =
  "A recurring thread in this newsletter is that subjective experience keeps " +
  "slipping out of the instruments we build to catch it. The connective tissue " +
  "you are reading is laid out entirely in JavaScript by pretext, which measures " +
  "each line against a width that changes as the text passes the floated plate to " +
  "the right. Beside the image the column is narrow; once the prose clears the " +
  "image it widens to the full measure of the page, and the whole arrangement " +
  "recomputes the moment you resize the window. This is the magazine feel we are " +
  "after: text that knows where the pictures are and politely flows around them, " +
  "rather than a rigid grid of boxes. It is a small demonstration, but it proves " +
  "the layout engine is wired up and behaving before any real article arrives.";

// Inline SVG data-URI so the spike works fully offline (no network image).
const IMG_SRC =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='220' height='160'>` +
      `<rect width='100%' height='100%' fill='#9c4a2f'/>` +
      `<text x='50%' y='50%' fill='#fff' font-family='Georgia' font-size='15' ` +
      `text-anchor='middle' dominant-baseline='middle'>floated plate</text></svg>`,
  );

function cursorsEqual(a: LayoutCursor, b: LayoutCursor): boolean {
  return a.segmentIndex === b.segmentIndex && a.graphemeIndex === b.graphemeIndex;
}

export function renderPretextSpike(container: HTMLElement): void {
  function render(): void {
    container.replaceChildren();

    const width = container.clientWidth || 600;
    const imgW = Math.min(220, Math.floor(width * 0.4));
    const narrow = Math.max(80, width - imgW - GAP);

    const img = document.createElement("img");
    img.src = IMG_SRC;
    img.alt = "a floated plate";
    img.className = "spike-img";
    img.style.width = `${imgW}px`;
    img.style.height = `${IMG_HEIGHT}px`;
    container.appendChild(img);

    const prepared = prepareWithSegments(SAMPLE, FONT);
    let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 };
    let y = 0;

    // Bounded loop: SAMPLE is short; the guard prevents any pathological spin.
    for (let i = 0; i < 2000; i++) {
      const maxWidth = y < IMG_HEIGHT ? narrow : width;
      const range = layoutNextLineRange(prepared, cursor, maxWidth);
      if (!range) break;

      const line = materializeLineRange(prepared, range);
      const div = document.createElement("div");
      div.className = "spike-line";
      div.textContent = line.text;
      div.style.top = `${y}px`;
      div.style.width = `${maxWidth}px`;
      container.appendChild(div);

      if (cursorsEqual(range.end, cursor)) break; // no progress -> stop
      cursor = range.end;
      y += LINE_HEIGHT;
    }

    container.style.height = `${Math.max(y, IMG_HEIGHT) + LINE_HEIGHT}px`;
  }

  render();

  let timer: number | undefined;
  window.addEventListener("resize", () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(render, 120); // debounced reflow
  });
}
