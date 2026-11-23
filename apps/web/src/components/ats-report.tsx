"use client";

import { Check, ChevronDown, Plus } from "lucide-react";
import { cx } from "@/components/ui/primitives";

export type AtsKeyword = {
  id: string; label: string; importance: "required" | "preferred"; job_term?: string; exact?: boolean; sections?: string[]; resume_term?: string;
};
export type AtsIssue = { severity: "high" | "medium" | "low"; title: string; detail: string; fix: string; area: string };
export type AtsResult = {
  score: number; grade: string;
  ats: { id: string; name: string; style: string; detected: string; tips: string[]; strict_parser: boolean; exact_keywords: boolean; human_first: boolean };
  components: { id: string; label: string; score: number; weight: number }[];
  keywords: { matched: AtsKeyword[]; alias_only: AtsKeyword[]; missing: AtsKeyword[] };
  issues: AtsIssue[];
  parsed: { kind: string; pages: number; words: number; email: string | null; phone: string | null; linkedin: string | null; sections: (string | null)[]; text: string };
  disclaimer: string;
  job?: { id: string | null; title: string | null; url: string | null; text: string | null };
};

export const scoreTone = (s: number) => (s >= 85 ? "#12925f" : s >= 70 ? "#b8902f" : s >= 50 ? "#c27a12" : "#c2410c");

export function ScoreRing({ value, size = 112 }: { value: number; size?: number }) {
  const r = 52, c = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 120 120" className="size-full -rotate-90" aria-hidden>
        <circle cx="60" cy="60" r={r} fill="none" stroke="#ece6d8" strokeWidth="10" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={scoreTone(value)} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(value / 100) * c} ${c}`} />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <span className="serif leading-none" style={{ fontSize: size * 0.32 }}>{value}</span>
      </div>
    </div>
  );
}

const VERDICT = (s: number) =>
  s >= 85 ? "Ready to apply" : s >= 70 ? "Good — a few quick fixes" : s >= 50 ? "Needs work before you apply" : "Likely to be filtered out";

/** A short, student-friendly ATS report: score, top fixes, keywords. Details stay folded. */
export function AtsReport({ r, compact, picked, onPick, onPickAll }: {
  r: AtsResult; compact?: boolean; picked?: Set<string>; onPick?: (label: string) => void; onPickAll?: (labels: string[]) => void;
}) {
  const kw = r.keywords;
  const fixes = r.issues.filter((i) => !/skills? not found/i.test(i.title)).slice(0, compact ? 2 : 4);
  const missing = [...kw.missing].sort((a, b) => Number(b.importance === "required") - Number(a.importance === "required"));
  const found = [...kw.matched, ...kw.alias_only];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-5">
        <ScoreRing value={r.score} size={compact ? 88 : 112} />
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted">ATS score · {r.ats.name}</p>
          <p className={cx("serif mt-1", compact ? "text-2xl" : "text-3xl")}>{VERDICT(r.score)}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {r.components.map((c) => (
              <span key={c.id} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-0.5 text-[12px] text-ink-2">
                <span className="size-1.5 rounded-full" style={{ background: scoreTone(c.score) }} />{c.label.split(" ")[0]} {c.score}
              </span>
            ))}
          </div>
        </div>
      </div>

      {missing.length || found.length ? (
        <div>
          <p className="text-sm font-semibold text-ink">Job keywords</p>
          {missing.length ? (
            <>
              <p className="text-[13px] text-muted mt-0.5">
                {onPick ? "Missing — tap the ones you really have, and we'll add them to your resume." : "Missing from your resume."}
                {onPickAll ? (() => {
                  const all = missing.map((k) => k.job_term || k.label);
                  const every = all.every((l) => picked?.has(l));
                  return <> <button type="button" onClick={() => onPickAll(every ? [] : all)} className="font-medium text-accent hover:underline">{every ? "Clear" : "Select all"}</button></>;
                })() : null}
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {missing.map((k) => {
                  const label = k.job_term || k.label;
                  const on = picked?.has(label);
                  return (
                    <li key={k.id}>
                      {onPick ? (
                        <button type="button" aria-pressed={on} onClick={() => onPick(label)}
                          className={cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[13px] transition",
                            on ? "border-ok bg-ok/10 text-ok" : "border-danger/30 bg-danger-soft text-danger hover:border-danger/60")}>
                          {on ? <Check aria-hidden className="size-3.5" /> : <Plus aria-hidden className="size-3.5" />}{label}
                          {k.importance === "required" && !on ? <span className="text-[11px] opacity-70">· must</span> : null}
                        </button>
                      ) : (
                        <span className="inline-flex rounded-full bg-danger-soft px-2.5 py-1 text-[13px] text-danger">{label}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
          {found.length ? (
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Keywords found">
              {found.map((k) => (
                <li key={k.id} className="inline-flex items-center gap-1 rounded-full bg-ok/10 px-2.5 py-1 text-[13px] text-ok">
                  <Check aria-hidden className="size-3.5" />{k.label}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {fixes.length ? (
        <div>
          <p className="text-sm font-semibold text-ink">Fix these</p>
          <ul className="mt-2 flex flex-col gap-2">
            {fixes.map((i, k) => (
              <li key={k} className="flex gap-2.5 text-[14px]">
                <span className={cx("mt-1.5 size-2 rounded-full shrink-0", i.severity === "high" ? "bg-danger" : i.severity === "medium" ? "bg-warn" : "bg-line-strong")} />
                <span><span className="font-medium text-ink">{i.title}.</span> <span className="text-ink-2">{i.fix}</span></span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!compact ? (
        <details className="group rounded-xl bg-surface-2 px-4 py-3">
          <summary className="cursor-pointer list-none text-sm font-medium text-ink-2 flex items-center gap-1.5">
            <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />What {r.ats.name} sees in your file
          </summary>
          <ul className="mt-2 list-disc pl-5 text-[13px] text-ink-2">{r.ats.tips.map((t, i) => <li key={i}>{t}</li>)}</ul>
          <p className="mt-2 text-[13px] text-ink-2">
            Email: {r.parsed.email ?? <b className="text-danger">not found</b>} · Phone: {r.parsed.phone ?? <b className="text-danger">not found</b>} · {r.parsed.pages} page{r.parsed.pages === 1 ? "" : "s"}, {r.parsed.words} words
          </p>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-surface p-3 text-[12px] leading-relaxed whitespace-pre-wrap break-words">{r.parsed.text}</pre>
          <p className="mt-2 text-[11.5px] text-muted">{r.disclaimer}</p>
        </details>
      ) : null}
    </div>
  );
}
