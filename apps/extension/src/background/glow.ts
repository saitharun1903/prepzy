// A short, decorative "Prepzy is working" glow around the page the user analysed.
//
// Runs only on the tab the user clicked Prepzy on (activeTab grant, no extra permissions), never blocks
// clicks (pointer-events: none except the small status pill), removes itself when the analysis ends, and
// honours prefers-reduced-motion. CSS goes in through chrome.scripting.insertCSS, which page CSPs cannot
// block; the DOM is built with textContent only.
import type { CaptureState } from "../shared/state";

export type GlowMode = "active" | "done" | "error";

export const GLOW_CSS = `
@property --prepzy-a { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
#prepzy-glow-root { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important;
  margin: 0 !important; padding: 0 !important; border: 0 !important; background: none !important; transition: opacity .6s ease !important; }
#prepzy-glow-root.prepzy-out { opacity: 0 !important; }
#prepzy-glow-root .prepzy-ring { position: absolute; inset: 0; padding: 7px; border-radius: 0;
  background: conic-gradient(from var(--prepzy-a), #f3dc9a, #c9a24b, #ff7ab6, #7c5cff, #3aa0ff, #2a4675, #f3dc9a);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
  animation: prepzy-spin 2.4s linear infinite; filter: drop-shadow(0 0 12px rgba(124, 92, 255, .8)) saturate(1.2); }
#prepzy-glow-root .prepzy-halo { position: absolute; inset: 0; border-radius: 0;
  box-shadow: inset 0 0 40px 10px rgba(124, 92, 255, .38), inset 0 0 110px 22px rgba(201, 162, 75, .3), inset 0 0 160px 30px rgba(255, 122, 182, .12);
  animation: prepzy-breathe 2.2s ease-in-out infinite; }
#prepzy-glow-root .prepzy-pill { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); pointer-events: auto; cursor: pointer;
  display: flex; align-items: center; gap: 8px; max-width: calc(100vw - 32px); padding: 8px 14px 8px 8px; border-radius: 999px;
  font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; letter-spacing: -.005em; color: #fff;
  background: linear-gradient(140deg, rgba(42, 70, 117, .96), rgba(15, 29, 51, .96)); border: 1px solid rgba(228, 199, 125, .7);
  box-shadow: 0 10px 30px -10px rgba(15, 29, 51, .7), 0 0 0 4px rgba(201, 162, 75, .18); animation: prepzy-drop .45s cubic-bezier(.2, .8, .2, 1); }
#prepzy-glow-root .prepzy-mark { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 7px; flex: none;
  font: 800 12px/1 system-ui, sans-serif; color: #1b2f52; background: linear-gradient(135deg, #f3dc9a, #c9a24b); }
#prepzy-glow-root .prepzy-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#prepzy-glow-root .prepzy-dots::after { content: "…"; animation: prepzy-dots 1.2s steps(3, end) infinite; display: inline-block; width: 1em; overflow: hidden; vertical-align: bottom; }
#prepzy-glow-root[data-mode="done"] .prepzy-ring { animation: none; background: linear-gradient(135deg, #6ee7b7, #12925f, #34d399, #6ee7b7);
  filter: drop-shadow(0 0 16px rgba(18, 146, 95, .9)); }
#prepzy-glow-root[data-mode="done"] .prepzy-halo { animation: prepzy-flash 1.2s ease-out 1; box-shadow: inset 0 0 60px 12px rgba(18, 146, 95, .4); }
#prepzy-glow-root[data-mode="done"] .prepzy-pill { border-color: rgba(110, 231, 183, .85); }
#prepzy-glow-root[data-mode="error"] .prepzy-ring { animation: none; background: linear-gradient(135deg, #f0a49c, #d1372c); filter: drop-shadow(0 0 10px rgba(209, 55, 44, .6)); }
#prepzy-glow-root[data-mode="error"] .prepzy-halo { animation: none; box-shadow: inset 0 0 36px 4px rgba(209, 55, 44, .25); }
#prepzy-glow-root[data-mode="error"] .prepzy-pill { border-color: rgba(240, 164, 156, .8); }
@keyframes prepzy-spin { to { --prepzy-a: 360deg; } }
@keyframes prepzy-breathe { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
@keyframes prepzy-flash { 0% { opacity: 1; } 100% { opacity: .6; } }
@keyframes prepzy-drop { from { opacity: 0; transform: translate(-50%, -10px); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes prepzy-dots { from { width: 0; } to { width: 1em; } }
@media (prefers-reduced-motion: reduce) {
  #prepzy-glow-root .prepzy-ring, #prepzy-glow-root .prepzy-halo, #prepzy-glow-root .prepzy-pill, #prepzy-glow-root .prepzy-dots::after { animation: none !important; }
}
`;

const TEXT: Record<GlowMode, string> = {
  active: "Prepzy is analysing this job",
  done: "✓ Your match is ready — open Prepzy",
  error: "Analysis didn’t finish — open Prepzy to retry",
};

/** Injected into the page (isolated world). Must be self-contained: no closures over module scope. */
export function applyGlow(mode: GlowMode, text: string): void {
  const ID = "prepzy-glow-root";
  const w = window as unknown as { __prepzyGlowTimer?: number };
  let root = document.getElementById(ID);
  if (!root) {
    root = document.createElement("div");
    root.id = ID;
    const ring = document.createElement("div");
    ring.className = "prepzy-ring";
    const halo = document.createElement("div");
    halo.className = "prepzy-halo";
    const pill = document.createElement("div");
    pill.className = "prepzy-pill";
    pill.title = "Dismiss";
    const mark = document.createElement("span");
    mark.className = "prepzy-mark";
    mark.textContent = "P";
    const label = document.createElement("span");
    label.className = "prepzy-text";
    pill.append(mark, label);
    pill.addEventListener("click", () => root?.remove());
    root.append(halo, ring, pill);
    (document.body ?? document.documentElement).append(root);
  }
  root.classList.remove("prepzy-out");
  root.dataset.mode = mode;
  const label = root.querySelector(".prepzy-text");
  if (label) {
    label.textContent = text;
    label.classList.toggle("prepzy-dots", mode === "active");
  }
  if (w.__prepzyGlowTimer) clearTimeout(w.__prepzyGlowTimer);
  const fadeIn = mode === "active" ? 120000 : mode === "done" ? 4500 : 6000; // active: safety net only
  w.__prepzyGlowTimer = window.setTimeout(() => {
    root?.classList.add("prepzy-out");
    window.setTimeout(() => root?.remove(), 700);
  }, fadeIn);
}

const cssDone = new Set<number>();
const lastMode = new Map<number, GlowMode>();

export function glowModeFor(state: CaptureState): GlowMode | null {
  if (state === "queued" || state === "analyzing") return "active";
  if (state === "completed" || state === "partial-result") return "done";
  if (state === "failed" || state === "timed-out") return "error";
  return null; // cancelled, idle, ... : leave the page alone
}

/** Show or update the glow on a tab. Never throws: decoration must not break capture. */
export async function showGlow(tabId: number, mode: GlowMode): Promise<void> {
  if (lastMode.get(tabId) === mode) return;
  try {
    if (!chrome.scripting?.insertCSS) return;
    if (!cssDone.has(tabId)) {
      await chrome.scripting.insertCSS({ target: { tabId }, css: GLOW_CSS });
      cssDone.add(tabId);
    }
    await chrome.scripting.executeScript({ target: { tabId }, func: applyGlow, args: [mode, TEXT[mode]] });
    lastMode.set(tabId, mode);
    if (mode !== "active") {
      lastMode.delete(tabId);
      cssDone.delete(tabId); // a later analysis on a reloaded page needs the CSS again
    }
  } catch {
    // Tab closed, navigated away (grant gone) or a page extensions cannot touch: no glow, no problem.
    lastMode.delete(tabId);
    cssDone.delete(tabId);
  }
}
