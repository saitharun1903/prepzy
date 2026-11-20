// "Eli", Prepzy's coach. An original inline-SVG character plus deterministic coaching copy.
// Every sentence is derived from the analysis + match report; nothing is invented.

import type { FitStatus, MatchView, RequirementView } from "../shared/jobview";
import { shortLabel } from "../shared/jobview";

export type Mood = "wave" | "happy" | "cheer" | "think";

// ------------------------------------------------------------------ checklist (merged, grouped)

export type Bucket = "have" | "partly" | "missing" | "check";

export interface ChecklistItem {
  label: string;
  bucket: Bucket;
  detail: string | null; // the posting's own wording (first source)
  note: string | null;
  importance: "required" | "preferred" | "other";
  keys: string[];
}

const BUCKET_OF: Record<FitStatus, Bucket> = {
  supported: "have",
  user_confirmed: "have",
  partial: "partly",
  adjacent: "partly",
  not_evidenced: "missing",
  not_met_confirmed: "missing",
  unassessable: "check",
};
const SEVERITY: Record<Bucket, number> = { missing: 3, partly: 2, have: 1, check: 0 };

/** One row per skill label: duplicates in the posting ("Java" twice) are merged. The merged
 * status is the most serious *assessed* one; "check yourself" only wins when nothing was assessed. */
export function buildChecklist(reqs: RequirementView[], match: MatchView | null | undefined): ChecklistItem[] {
  const byLabel = new Map<string, ChecklistItem>();
  for (const r of reqs) {
    if (r.negated) continue;
    const base = r.concepts.length ? (r.alternatives ? r.alternatives.join(" or ") : r.concepts.slice(0, 3).join(" + ")) : shortLabel(r);
    const key = base.toLowerCase();
    const st = match?.hasResume ? match.status[r.key] : undefined;
    const bucket: Bucket = st ? BUCKET_OF[st] : "check";
    const importance = r.importance === "required" ? "required" : r.importance === "preferred" || r.importance === "optional" ? "preferred" : "other";
    const existing = byLabel.get(key);
    if (!existing) {
      byLabel.set(key, {
        label: base,
        bucket,
        detail: r.text !== base ? r.text : null,
        note: r.years && bucket !== "missing" ? `${r.years} asked` : null,
        importance,
        keys: [r.key],
      });
      continue;
    }
    existing.keys.push(r.key);
    if (importance === "required") existing.importance = "required";
    if (SEVERITY[bucket] > SEVERITY[existing.bucket] && bucket !== "check") existing.bucket = bucket;
    else if (existing.bucket === "check" && bucket !== "check") existing.bucket = bucket;
    if (r.years && !existing.note) existing.note = `${r.years} asked`;
  }
  return [...byLabel.values()];
}

// ------------------------------------------------------------------ coaching copy

export interface CoachLine {
  mood: Mood;
  greeting: string;
  verdict: string;
  advice: string | null;
  primary: { label: string; action: "practice" | "plan" | "resume" | "analyze" } | null;
  secondary: { label: string; action: "practice" | "plan" | "resume" | "report" } | null;
}

export function coach(opts: {
  name: string | null;
  company: string | null;
  items: ChecklistItem[];
  match: MatchView | null | undefined;
  partial: boolean;
}): CoachLine {
  const hi = opts.name ? `Hi ${opts.name}!` : "Here's my read.";
  const at = opts.company ? ` at ${opts.company}` : "";
  const must = opts.items.filter((i) => i.importance === "required");
  const pool = must.length ? must : opts.items;
  const have = pool.filter((i) => i.bucket === "have");
  const gaps = pool.filter((i) => i.bucket === "missing");
  const partly = pool.filter((i) => i.bucket === "partly");
  const firstGap = gaps[0]?.label ?? partly[0]?.label ?? null;

  if (opts.partial) {
    return { mood: "think", greeting: hi, verdict: "The AI model was busy, so this is only a quick read of the posting.", advice: "Run it again for a full analysis.", primary: { label: "Analyze again", action: "analyze" }, secondary: { label: "Open full report", action: "report" } };
  }
  if (opts.match === undefined) {
    return { mood: "think", greeting: hi, verdict: "Checking this job against your resume…", advice: null, primary: null, secondary: null };
  }
  if (!opts.match || !opts.match.hasResume) {
    return { mood: "wave", greeting: hi, verdict: `I've read this role${at}. Add your resume and I'll tell you exactly where you stand.`, advice: null, primary: { label: "Add my resume", action: "resume" }, secondary: { label: "Practice anyway", action: "practice" } };
  }
  if (!pool.length || opts.match.scoreStatus === "withheld" || have.length + gaps.length + partly.length === 0) {
    return { mood: "think", greeting: hi, verdict: "This posting doesn't list enough clear requirements for me to judge your fit.", advice: "Open the full report to confirm the ones I couldn't check.", primary: { label: "Practice interview", action: "practice" }, secondary: { label: "Open full report", action: "report" } };
  }
  const total = have.length + gaps.length + partly.length;
  const frac = `${have.length} of ${total}`;
  const noun = must.length ? "must-have" : "requirement";
  const kind = total === 1 ? noun : `${noun}s`;
  if (!gaps.length && !partly.length) {
    return { mood: "happy", greeting: hi, verdict: total === 1 ? `Your resume shows the ${noun} for this role${at}. You're a strong fit.` : `Your resume shows all ${total} ${kind} for this role${at}. You're a strong fit.`, advice: "Apply, then sharpen your answers before the interview.", primary: { label: "Practice 5 questions", action: "practice" }, secondary: { label: "Open full report", action: "report" } };
  }
  if (have.length * 2 >= total) {
    return { mood: "cheer", greeting: hi, verdict: `You match ${frac} ${kind}${at}. You're close.`, advice: firstGap ? `Biggest gap: ${firstGap}. If you've used it, add it to your resume; if not, I'll build a short plan.` : null, primary: { label: firstGap ? `Practice ${firstGap}` : "Practice interview", action: "practice" }, secondary: { label: "Build a prep plan", action: "plan" } };
  }
  return { mood: "think", greeting: hi, verdict: `This is a stretch: your resume shows ${frac} ${kind}${at}.`, advice: firstGap ? `Start with ${firstGap}. A focused plan gets you there faster than applying now.` : null, primary: { label: "Build a prep plan", action: "plan" }, secondary: { label: "Practice interview", action: "practice" } };
}

// ------------------------------------------------------------------ avatar (inline SVG)

const NS = "http://www.w3.org/2000/svg";

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: SVGElement[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.append(c);
  return el;
}

const MOUTH: Record<Mood, string> = {
  wave: "M27 41 Q32 45.5 37 41",
  happy: "M25.5 39.5 Q32 47.5 38.5 39.5",
  cheer: "M26 40 Q32 46 38 40",
  think: "M27.5 42.5 Q32 41 36.5 42.5",
};
const BROWS: Record<Mood, [string, string]> = {
  wave: ["M21.5 24.5 Q24.5 23 27.5 24.5", "M36.5 24.5 Q39.5 23 42.5 24.5"],
  happy: ["M21.5 24 Q24.5 22 27.5 24", "M36.5 24 Q39.5 22 42.5 24"],
  cheer: ["M21.5 23.5 Q24.5 22.5 27.5 24.5", "M36.5 24.5 Q39.5 22.5 42.5 23.5"],
  think: ["M21.5 25 Q24.5 24.5 27.5 23.5", "M36.5 23 Q39.5 22.5 42.5 24"],
};

/** Eli: a rounded, friendly coach. Body uses the accent color; face is drawn in surface/ink so it
 * works in light and dark themes. Decorative (aria-hidden): the speech bubble carries the meaning. */
export function avatar(mood: Mood, size = 56): SVGSVGElement {
  const happy = mood === "happy" || mood === "cheer";
  const eye = (cx: number) =>
    happy
      ? s("path", { d: `M${cx - 3} 31.5 Q${cx} 28 ${cx + 3} 31.5`, fill: "none", stroke: "var(--coach-ink)", "stroke-width": 2.4, "stroke-linecap": "round" })
      : s("g", { class: "coach-eye" }, s("ellipse", { cx, cy: 31, rx: 2.6, ry: 3.1, fill: "var(--coach-ink)" }), s("circle", { cx: cx + 0.9, cy: 29.9, r: 0.9, fill: "var(--coach-face)" }));
  const svg = s(
    "svg",
    { viewBox: "0 0 64 64", width: size, height: size, class: `coach coach-${mood}`, "aria-hidden": "true", focusable: "false" },
    // antenna + spark (an "elevating" idea)
    s("path", { d: "M32 11 V5.5", stroke: "var(--coach-body)", "stroke-width": 2.6, "stroke-linecap": "round" }),
    s("circle", { cx: 32, cy: 4.5, r: 3.2, fill: "var(--coach-spark)", class: "coach-spark" }),
    // body
    s("rect", { x: 9, y: 10, width: 46, height: 46, rx: 17, fill: "var(--coach-body)" }),
    // face plate
    s("rect", { x: 15, y: 17, width: 34, height: 33, rx: 13, fill: "var(--coach-face)" }),
    // cheeks
    s("circle", { cx: 20.5, cy: 39, r: 2.6, fill: "var(--coach-cheek)" }),
    s("circle", { cx: 43.5, cy: 39, r: 2.6, fill: "var(--coach-cheek)" }),
    s("path", { d: BROWS[mood][0], fill: "none", stroke: "var(--coach-ink)", "stroke-width": 1.8, "stroke-linecap": "round" }),
    s("path", { d: BROWS[mood][1], fill: "none", stroke: "var(--coach-ink)", "stroke-width": 1.8, "stroke-linecap": "round" }),
    eye(24.5),
    eye(39.5),
    s("path", { d: MOUTH[mood], fill: "none", stroke: "var(--coach-ink)", "stroke-width": 2.3, "stroke-linecap": "round" }),
  );
  if (mood === "wave") {
    svg.append(s("path", { d: "M55 30 q6 -4 5 -11", fill: "none", stroke: "var(--coach-body)", "stroke-width": 4.5, "stroke-linecap": "round", class: "coach-hand" }));
  }
  return svg;
}
