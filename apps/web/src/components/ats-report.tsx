"use client";

import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronDown, Info, XCircle } from "lucide-react";
import { Badge, cx } from "@/components/ui/primitives";

export type AtsKeyword = { id: string; label: string; importance: "required" | "preferred"; job_term?: string; exact?: boolean; sections?: string[] };
export type AtsIssue = { severity: "high" | "medium" | "low"; title: string; detail: string; fix: string; area: string };
export type AtsResult = {
  score: number; grade: string;
  ats: { id: string; name: string; style: string; detected: string; tips: string[]; strict_parser: boolean; exact_keywords: boolean; human_first: boolean };
  components: { id: string; label: string; score: number; weight: number }[];
  keywords: { matched: AtsKeyword[]; alias_only: AtsKeyword[]; missing: AtsKeyword[] };
  issues: AtsIssue[];
  parsed: { kind: string; pages: number; words: number; email: string | null; phone: string | null; linkedin: string | null; sections: (string | null)[]; text: string };
  disclaimer: string;
};

const tone = (s: number) => (s >= 85 ? "#12925f" : s >= 70 ? "#c9a24b" : s >= 50 ? "#c27a12" : "#c2410c");

function Ring({ value }: { value: number }) {
  const r = 52, c = 2 * Math.PI * r;
  return (
    <div className="relative size-[128px] shrink-0">
      <svg viewBox="0 0 120 120" className="size-full -rotate-90" aria-hidden>
        <circle cx="60" cy="60" r={r} fill="none" stroke="#ece6d8" strokeWidth="10" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={tone(value)} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(value / 100) * c} ${c}`} />
      </svg>
      <div className="absolute inset-0 grid place-items-center"><span className="serif text-[40px] leading-none">{value}<span className="text-lg text-muted">/100</span></span></div>
    </div>
  );
}

const SEV = {
  high: { icon: AlertOctagon, cls: "text-danger", label: "Fix first" },
  medium: { icon: AlertTriangle, cls: "text-warn", label: "Important" },
  low: { icon: Info, cls: "text-ink-2", label: "Nice to fix" },
} as const;

export function AtsReport({ r, compact }: { r: AtsResult; compact?: boolean }) {
  const kw = r.keywords;
  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6 shadow-[0_18px_50px_-30px_rgba(15,29,51,0.45)]">
        <div className="flex flex-col sm:flex-row gap-6 sm:items-center">
          <Ring value={r.score} />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted">ATS score · {r.ats.name}</p>
            <h2 className="serif text-3xl mt-1">{r.grade}</h2>
            <p className="text-[14px] text-ink-2 mt-1">{r.ats.style}</p>
            <p className="text-[12.5px] text-muted mt-1">System {r.ats.detected}.</p>
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {r.components.map((c) => (
            <div key={c.id}>
              <div className="flex justify-between text-[13px]"><span className="text-ink">{c.label}</span><span className="text-muted">{c.score}/100 · {c.weight}% of score</span></div>
              <div className="mt-1 h-2 rounded-full bg-surface-2 overflow-hidden" role="progressbar" aria-valuenow={c.score} aria-valuemin={0} aria-valuemax={100} aria-label={c.label}>
                <div className="h-full rounded-full" style={{ width: `${c.score}%`, background: tone(c.score) }} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="fix-h">
        <h3 id="fix-h" className="serif text-2xl mb-3">What to fix {r.issues.length ? `(${r.issues.length})` : ""}</h3>
        {r.issues.length ? (
          <ul className="flex flex-col gap-2">
            {r.issues.map((i, k) => {
              const S = SEV[i.severity];
              return (
                <li key={k} className="rounded-xl border border-line bg-surface px-4 py-3">
                  <div className="flex items-start gap-2.5">
                    <S.icon aria-hidden className={cx("size-5 shrink-0 mt-0.5", S.cls)} />
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{i.title} <span className={cx("ml-1 text-[11.5px] font-semibold uppercase tracking-wide", S.cls)}>{S.label}</span></p>
                      <p className="text-[13.5px] text-ink-2 mt-0.5">{i.detail}</p>
                      <p className="text-[13.5px] mt-1"><b className="text-ok">Fix:</b> <span className="text-ink">{i.fix}</span></p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : <p className="text-sm text-ok inline-flex items-center gap-1.5"><CheckCircle2 aria-hidden className="size-4" />No problems found.</p>}
      </section>

      <section aria-labelledby="kw-h" className="rounded-2xl border border-line bg-surface p-5">
        <h3 id="kw-h" className="serif text-2xl">Job keywords</h3>
        <p className="text-[13px] text-muted mt-0.5">{r.ats.exact_keywords ? `${r.ats.name} matches words literally — use the job's exact terms.` : "Skills the job asks for, and whether your resume shows them."}</p>
        <div className="mt-3 flex flex-col gap-3">
          {kw.missing.length ? (
            <div><p className="text-sm font-medium text-danger mb-1.5 inline-flex items-center gap-1.5"><XCircle aria-hidden className="size-4" />Missing ({kw.missing.length})</p>
              <ul className="flex flex-wrap gap-1.5">{kw.missing.map((k) => <li key={k.id}><Badge tone="danger">{k.job_term || k.label}{k.importance === "required" ? " · required" : ""}</Badge></li>)}</ul></div>
          ) : null}
          {kw.alias_only.length ? (
            <div><p className="text-sm font-medium text-warn mb-1.5">Written differently ({kw.alias_only.length})</p>
              <ul className="flex flex-wrap gap-1.5">{kw.alias_only.map((k) => <li key={k.id}><Badge tone="warn">use “{k.job_term}”</Badge></li>)}</ul></div>
          ) : null}
          {kw.matched.length ? (
            <div><p className="text-sm font-medium text-ok mb-1.5 inline-flex items-center gap-1.5"><CheckCircle2 aria-hidden className="size-4" />Found ({kw.matched.length})</p>
              <ul className="flex flex-wrap gap-1.5">{kw.matched.map((k) => <li key={k.id}><Badge tone="ok">{k.label}</Badge></li>)}</ul></div>
          ) : null}
          {!kw.missing.length && !kw.matched.length && !kw.alias_only.length ? <p className="text-sm text-muted">No specific skills found in this job description.</p> : null}
        </div>
      </section>

      {!compact ? (
        <>
          <section aria-labelledby="tips-h" className="rounded-2xl bg-accent-soft p-5">
            <h3 id="tips-h" className="font-semibold text-ink">How {r.ats.name} handles resumes</h3>
            <ul className="mt-2 list-disc pl-5 text-[13.5px] text-ink-2 flex flex-col gap-1">{r.ats.tips.map((t, i) => <li key={i}>{t}</li>)}</ul>
          </section>

          <details className="rounded-2xl border border-line bg-surface px-5 py-4 group">
            <summary className="cursor-pointer font-medium text-ink flex items-center gap-2"><ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />What the ATS sees in your file</summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-3 text-[13px]">
              <p><span className="text-muted">Email:</span> {r.parsed.email ?? <b className="text-danger">not found</b>}</p>
              <p><span className="text-muted">Phone:</span> {r.parsed.phone ?? <b className="text-danger">not found</b>}</p>
              <p><span className="text-muted">LinkedIn:</span> {r.parsed.linkedin ?? <span className="text-muted">not found</span>}</p>
              <p><span className="text-muted">Pages:</span> {r.parsed.pages} · {r.parsed.words} words</p>
              <p className="sm:col-span-2"><span className="text-muted">Sections:</span> {r.parsed.sections.filter(Boolean).join(" · ") || "none detected"}</p>
            </div>
            <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-surface-2 p-3 text-[12px] leading-relaxed whitespace-pre-wrap break-words">{r.parsed.text}</pre>
          </details>
        </>
      ) : null}
      <p className="text-[12px] text-muted">{r.disclaimer}</p>
    </div>
  );
}
