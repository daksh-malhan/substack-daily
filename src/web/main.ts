/**
 * Frontend entry (MG8–MG11 + "The Press" redesign). Drives five views on the
 * press bed — idle / docket (live build) / error / magazine / back-issues — and
 * streams `POST /surprise` as Server-Sent Events, stamping each real pipeline
 * stage onto the docket. Pure markup/preset/parse logic lives in render.ts /
 * vibe.ts / progress.ts (unit-tested); this file only does DOM side effects.
 *
 * Offline-safe: the Library fetches only same-origin local data and images load
 * via the same-origin /library-assets route — no remote requests.
 */
import type { Magazine } from "../shared/magazine.ts";
import { layoutArticle } from "./article-layout.ts";
import { escapeHtml, magazineHostAttrs, renderLibraryList, renderMagazineHTML, type LibrarySummary } from "./render.ts";
import { docketStates, parseSse, PRESS_STEPS } from "./progress.ts";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);

const surpriseBtns = [$("#surprise"), $("#surprise-hero")].filter(Boolean) as HTMLButtonElement[];
const libraryBtn = $<HTMLButtonElement>("#library");
const retryBtn = $<HTMLButtonElement>("#retry");
const idle = $("#idle");
const docket = $("#docket");
const errorPanel = $("#error");
const errorMsg = $("#error-msg");
const article = $<HTMLElement>("#magazine");
const resultsList = $<HTMLElement>("#results");
const libraryList = $<HTMLElement>("#library-list");

let disposeLayout: (() => void) | null = null;

type View = "idle" | "docket" | "error" | "magazine" | "results" | "library";
const views: Record<View, HTMLElement | null> = {
  idle,
  docket,
  error: errorPanel,
  magazine: article,
  results: resultsList,
  library: libraryList,
};
function showView(view: View): void {
  for (const [name, el] of Object.entries(views)) {
    if (el) el.hidden = name !== view;
  }
  if (view !== "magazine") clearMagazineShell();
}

// When a magazine is open, the press shell (desk + header + accent) takes on the
// OPEN issue's vibe palette — derived from its --paper/--ink and accent — so the
// whole page reads as one cohesive issue. Reverts to the theme shell otherwise.
const SHELL_OVERRIDES = ["--desk", "--desk-2", "--on-desk", "--ink-soft", "--hair", "--flag", "--flag-ink"];

const srgbToLinear = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance of a #rrggbb color (NaN if unparseable). */
function relativeLuminance(hex: string): number {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return NaN;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => srgbToLinear(parseInt(h!, 16) / 255));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrastRatio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const INK_DARK = "#14110e";
const INK_LIGHT = "#ffffff";
/** Pick whichever of dark/white text has the HIGHER actual contrast on `accent`. */
function readableInkOn(accent: string): string {
  const La = relativeLuminance(accent);
  if (Number.isNaN(La)) return INK_LIGHT;
  return contrastRatio(La, relativeLuminance(INK_DARK)) >= contrastRatio(La, relativeLuminance(INK_LIGHT))
    ? INK_DARK
    : INK_LIGHT;
}

function applyMagazineShell(el: HTMLElement, accent: string): void {
  const cs = getComputedStyle(el);
  const paper = cs.getPropertyValue("--paper").trim() || "#efe8d8";
  const ink = cs.getPropertyValue("--ink").trim() || "#16233c";
  const s = document.body.style;
  s.setProperty("--desk", `color-mix(in srgb, ${paper} 88%, #000)`); // a darker mat around the sheet
  s.setProperty("--desk-2", `color-mix(in srgb, ${paper} 78%, #000)`);
  s.setProperty("--on-desk", ink);
  // ink-heavy so secondary text keeps contrast on the desk for light AND dark papers
  s.setProperty("--ink-soft", `color-mix(in srgb, ${ink} 68%, ${paper})`);
  s.setProperty("--hair", `color-mix(in srgb, ${ink} 18%, transparent)`);
  s.setProperty("--flag", accent); // header + buttons take the issue's accent
  s.setProperty("--flag-ink", readableInkOn(accent)); // legible button text on that accent
}
function clearMagazineShell(): void {
  for (const v of SHELL_OVERRIDES) document.body.style.removeProperty(v);
}

function setBusy(busy: boolean): void {
  for (const b of surpriseBtns) b.disabled = busy;
}

// ---- live build docket -----------------------------------------------------

const TICK: Record<"done" | "active" | "pending", string> = { done: "■", active: "▸", pending: "·" };

function renderDocket(completedPhases: string[], pressed: number, finished: boolean): void {
  if (!docket) return;
  const states = finished ? PRESS_STEPS.map((s) => ({ ...s, state: "done" as const })) : docketStates(completedPhases);
  const steps = states
    .map((step, i) => {
      const num = String(i + 1).padStart(2, "0");
      return `<li class="docket-step ${step.state}"><span class="tick">${TICK[step.state]}</span><span>${step.label}</span><span class="docket-num">${num}</span></li>`;
    })
    .join("");
  const pressedLine = pressed > 0 ? `<p class="docket-pressed">◆ pressed ${pressed} deep-dive${pressed === 1 ? "" : "s"} so far…</p>` : "";
  docket.innerHTML = `<p class="docket-head">Pulling deep-dives — this can take a few minutes</p><ul class="docket-list">${steps}</ul>${pressedLine}`;
}

function showError(message: string): void {
  if (errorMsg) errorMsg.textContent = message;
  showView("error");
}

function renderMagazine(magazine: Magazine): void {
  if (!article) return;
  disposeLayout?.(); // stop observing the previous magazine before replacing it
  const { className, accent } = magazineHostAttrs(magazine);
  article.className = className;
  article.style.setProperty("--accent", accent);
  article.innerHTML = renderMagazineHTML(magazine);
  showView("magazine");
  applyMagazineShell(article, accent); // the room takes on this issue's ink
  // Flow each section's prose around its draggable image (MG9); reflows on resize.
  disposeLayout = layoutArticle(article);
}

// ---- the press run (SSE) ---------------------------------------------------

/** Render the set of just-pressed deep-dives as openable cards. */
function renderResults(publication: string, magazines: Magazine[]): void {
  if (!resultsList) return;
  const summaries: LibrarySummary[] = magazines.map((m) => ({
    id: m.id,
    title: m.title,
    newsletter: m.newsletter,
    themes: m.themes,
    vibePresetId: m.vibePresetId,
    accentColor: m.accentColor,
    generatedAt: m.generatedAt,
  }));
  const head = `<p class="results-head">Pressed ${magazines.length} deep-dives from ${escapeHtml(publication)} — open one below, or find them all in Back issues.</p>`;
  resultsList.innerHTML = head + renderLibraryList(summaries);
  showView("results");
}

/** Route the finished run: nothing deep -> retry; one -> read it; many -> the set. */
function finishRun(publication: string, magazines: Magazine[]): void {
  if (magazines.length === 0) showError("Nothing deep enough in that one — try again for a different publication.");
  else if (magazines.length === 1) renderMagazine(magazines[0]!);
  else renderResults(publication, magazines);
}

async function surprise(): Promise<void> {
  setBusy(true);
  showView("docket");
  renderDocket([], 0, false);
  try {
    const res = await fetch("/surprise", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: "{}",
    });
    if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      showError(detail?.error?.message ?? `the press returned ${res.status}`);
      return;
    }
    await consumeStream(res.body);
  } catch (error) {
    showError(`couldn't reach the press — ${String(error)}`);
  } finally {
    setBusy(false);
  }
}

const PHASE_STAGES = new Set(["pick", "fetch", "curate"]); // the leading docket phases

/** Read the SSE stream: stamp the docket per phase, collect each deep-dive, route on `done`. */
async function consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const phases: string[] = [];
  const magazines: Magazine[] = [];
  let settled = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSse(buffer);
    buffer = rest;
    for (const ev of events) {
      if (ev.event === "stage") {
        const { stage } = JSON.parse(ev.data) as { stage: string };
        if (PHASE_STAGES.has(stage) && !phases.includes(stage)) phases.push(stage);
        renderDocket(phases, magazines.length, false);
      } else if (ev.event === "result") {
        magazines.push(JSON.parse(ev.data) as Magazine); // one deep-dive finished
        renderDocket(phases, magazines.length, false);
      } else if (ev.event === "done") {
        const { publication } = JSON.parse(ev.data) as { publication?: string };
        settled = true;
        finishRun(publication ?? "this publication", magazines);
      } else if (ev.event === "error") {
        const { error } = JSON.parse(ev.data) as { error?: { message?: string } };
        showError(error?.message ?? "the press jammed");
        settled = true;
      }
    }
  }
  if (!settled) showError("the press stopped before the deep-dives were finished");
}

// ---- back issues -----------------------------------------------------------

async function showLibrary(): Promise<void> {
  if (!libraryList) return;
  disposeLayout?.();
  showView("library");
  libraryList.innerHTML = `<p class="lib-empty">Opening your back issues…</p>`;
  try {
    const entries = (await (await fetch("/api/library")).json()) as LibrarySummary[];
    libraryList.innerHTML = renderLibraryList(entries);
  } catch {
    libraryList.innerHTML = `<p class="lib-empty">Couldn't open your back issues.</p>`;
  }
}

async function openEntry(id: string): Promise<void> {
  const res = await fetch(`/api/library/${encodeURIComponent(id)}`);
  if (res.ok) renderMagazine((await res.json()) as Magazine);
}

async function deleteEntry(id: string): Promise<void> {
  if (!globalThis.confirm("Delete this issue from your back issues?")) return;
  await fetch(`/api/library/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  void showLibrary();
}

function onCardClick(event: Event): void {
  const el = (event.target as HTMLElement).closest<HTMLElement>("[data-id]");
  const id = el?.dataset.id;
  if (!el || !id) return;
  if (el.classList.contains("lib-delete")) void deleteEntry(id);
  else if (el.classList.contains("lib-open")) void openEntry(id);
}
libraryList?.addEventListener("click", onCardClick);
resultsList?.addEventListener("click", onCardClick); // the just-pressed set opens the same way

// ---- theme toggle (the initial theme is set pre-paint by an inline script) --

const themeToggle = $<HTMLButtonElement>("#theme-toggle");
function syncThemeButton(): void {
  const isLight = document.documentElement.dataset.theme === "light";
  if (themeToggle) themeToggle.textContent = isLight ? "Dark mode" : "Light mode"; // names the mode you'd switch TO
}
themeToggle?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("press-theme", next);
  } catch {
    // storage unavailable — the choice just won't persist across reloads
  }
  syncThemeButton();
});
syncThemeButton();

for (const b of surpriseBtns) b.addEventListener("click", surprise);
retryBtn?.addEventListener("click", surprise);
libraryBtn?.addEventListener("click", showLibrary);
