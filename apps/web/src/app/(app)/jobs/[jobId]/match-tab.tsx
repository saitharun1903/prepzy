"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight, CheckCircle2, ChevronDown, CircleDashed, CircleHelp, CircleMinus, CircleSlash, FileText, MessageCircle,
  MessagesSquare, RefreshCw, Sparkles, UserCheck, Wand2, XCircle,
} from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { MatchReport, MatchStatus, MatchUnit } from "@/lib/types";
import { ResumeVersionSelect, type VersionPick } from "@/components/resume-version-select";
import { Badge, Button, EmptyState, ErrorState, LoadingBlock, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { addCorrection } from "./shared";

// Plain-language labels: what the person should understand at a glance.
const STATUS: Record<MatchStatus, { label: string; icon: typeof CheckCircle2; tone: string }> = {
  supported: { label: "You have this", icon: CheckCircle2, tone: "text-ok" },
  user_confirmed: { label: "You said you have this", icon: UserCheck, tone: "text-ok" },
  partial: { label: "Partly", icon: CircleMinus, tone: "text-warn" },
  adjacent: { label: "Related skill only", icon: CircleDashed, tone: "text-warn" },
  not_evidenced: { label: "Missing from resume", icon: XCircle, tone: "text-danger" },
  not_met_confirmed: { label: "You said you don't", icon: CircleSlash, tone: "text-danger" },
  unassessable: { label: "Tell us", icon: CircleHelp, tone: "text-muted" },
  soft_skill: { label: "Soft skill", icon: MessageCircle, tone: "text-accent" },
};

export function StatusLabel({ status }: { status: MatchStatus }) {
  const s = STATUS[status] || STATUS.unassessable;
  const Icon = s.icon;
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-sm font-medium", s.tone)}>
      <Icon aria-hidden className="size-4 shrink-0" />
      <span>{s.label}</span>
    </span>
  );
}

type Bucket = "have" | "partly" | "missing" | "check" | "soft";
const BUCKET_OF: Record<MatchStatus, Bucket> = {
  supported: "have", user_confirmed: "have", partial: "partly", adjacent: "partly",
  not_evidenced: "missing", not_met_confirmed: "missing", unassessable: "check", soft_skill: "soft",
};
const BUCKETS: { id: Bucket; title: string; hint: string; icon: typeof CheckCircle2; tone: string }[] = [
  { id: "missing", title: "Missing from your resume", hint: "The job asks for these and your resume doesn't show them. Learn them or add them if you already have them.", icon: XCircle, tone: "text-danger" },
  { id: "partly", title: "Partly there", hint: "You have something close. Make it clearer on your resume.", icon: CircleMinus, tone: "text-warn" },
  { id: "check", title: "Tell us if you have these", hint: "Prepzy can't check these from a resume. Tick the ones you meet and your score updates.", icon: CircleHelp, tone: "text-ink-2" },
  { id: "have", title: "You already have", hint: "Found in your resume or confirmed by you.", icon: CheckCircle2, tone: "text-ok" },
  { id: "soft", title: "Soft skills to show in the interview", hint: "Not scored. Prepare one short real example for each.", icon: MessageCircle, tone: "text-accent" },
];

function verdict(cov: number | null, withheld: boolean): { title: string; text: string; tone: "ok" | "accent" | "warn" | "danger" | "neutral" } {
  if (withheld || cov === null) return { title: "Not enough to score yet", text: "", tone: "neutral" };
  if (cov >= 75) return { title: "Strong match", text: "You meet most of what this job asks for. Apply with confidence and practise the interview.", tone: "ok" };
  if (cov >= 50) return { title: "Good match", text: "You meet the core requirements. Close the gaps below to stand out.", tone: "accent" };
  if (cov >= 25) return { title: "Partial match", text: "Some key skills are missing. Work on the gaps first, or apply and lead with what you have.", tone: "warn" };
  return { title: "Stretch role", text: "Most requirements aren't on your resume yet. Use the study plan to build them.", tone: "danger" };
}

const RING: Record<string, string> = { ok: "#12925f", accent: "#c9a24b", warn: "#c27a12", danger: "#c2410c", neutral: "#c9cfd9" };

function ScoreRing({ value, tone }: { value: number | null; tone: string }) {
  const r = 52, c = 2 * Math.PI * r, pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="relative size-[132px] shrink-0">
      <svg viewBox="0 0 120 120" className="size-full -rotate-90" aria-hidden>
        <circle cx="60" cy="60" r={r} fill="none" stroke="#ece6d8" strokeWidth="10" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={RING[tone]} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`} className="transition-[stroke-dasharray] duration-700" />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        {value === null ? <span className="serif text-3xl text-muted">—</span> : (
          <span className="serif text-[40px] leading-none">{Math.round(value)}<span className="text-lg text-muted">%</span></span>
        )}
      </div>
    </div>
  );
}

export function MatchTab({ jobId, hasAnalysis, onJobChanged, onGoTo }: {
  jobId: string; hasAnalysis: boolean; onJobChanged: () => void; onGoTo?: (tab: string) => void;
}) {
  const { notify } = useToast();
  const [report, setReport] = useState<MatchReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [pick, setPick] = useState<VersionPick>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);
  const [showResume, setShowResume] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch<{ report: MatchReport | null }>(`jobs/${jobId}/match/latest`)
      .then((r) => {
        if (!alive) return;
        setReport(r.report);
        const res = r.report?.result.resume;
        setPick(res ? { resumeId: res.resume_id, versionId: res.version_id } : null);
        setPicked(true);
      })
      .catch((e) => { if (alive) { setError(e as ApiError); setPicked(true); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [jobId]);

  const compute = async (versionId: string | null, quiet = false) => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<MatchReport>(`jobs/${jobId}/match`, { method: "POST", body: { resume_version_id: versionId } });
      setReport(r);
      if (!quiet) notify("ok", r.reused ? "Nothing changed — your score is up to date" : "Score updated");
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  // Matching is instant and uses no AI: compare automatically on the first visit, and refresh a
  // report that is out of date, so the person always lands on a current result.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || loading || busy || error || !hasAnalysis) return;
    if (!report && pick?.versionId) {
      autoRan.current = true;
      void compute(pick.versionId, true);
    } else if (report && report.stale_reasons.length) {
      autoRan.current = true;
      void compute(report.result.resume?.version_id ?? null, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, report, busy, error, hasAnalysis, pick]);

  const confirm = async (u: { key: string }, met: boolean) => {
    if (!report) return;
    setConfirming(u.key + String(met));
    try {
      await addCorrection(jobId, { analysis_id: report.result.inputs.analysis_id, target: "confirmation", key: u.key, value: { met } });
      onJobChanged();
      await compute(report.result.resume?.version_id ?? null, true);
      notify("ok", "Saved — score updated");
    } catch (e) {
      notify("error", (e as ApiError).message);
    } finally {
      setConfirming(null);
    }
  };

  if (!hasAnalysis) return <EmptyState title="Analyse the job first">Your match needs the job&apos;s requirements.</EmptyState>;
  if (loading) return <LoadingBlock rows={3} label="Loading your match" />;

  const r = report?.result;
  const withheld = r?.summary.score_status === "withheld";
  const cov = r && !withheld ? r.summary.required.coverage : null;
  const v = verdict(cov, withheld);
  const units = r ? r.requirements : [];
  const byBucket = (b: Bucket) => units.filter((u) => BUCKET_OF[u.status] === b);
  const count = (b: Bucket) => byBucket(b).length;
  const missingSkills = r ? r.priorities.filter((p) => p.importance === "required").map((p) => p.label).slice(0, 4) : [];

  const resumeBar = (
    <div className="rounded-xl border border-line bg-surface/70 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <FileText aria-hidden className="size-4 text-muted" />
        <span className="text-ink-2">
          {r?.resume ? <>Compared with <b className="text-ink">resume version {r.resume.version}</b></> : report ? "Compared with your profile skills only" : "Choose a resume to compare"}
          {report ? <span className="text-muted"> · {formatDateTime(report.created_at)}</span> : null}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setShowResume((x) => !x)} aria-expanded={showResume}>
          Change resume <ChevronDown aria-hidden className={cx("size-3.5 transition-transform", showResume && "rotate-180")} />
        </Button>
        <Button size="sm" variant="secondary" loading={busy} onClick={() => compute(pick?.versionId ?? null)}>
          <RefreshCw aria-hidden className="size-3.5" />Update score
        </Button>
      </div>
      {(showResume || !report) && picked ? (
        <div className="mt-3 max-w-xl">
          <ResumeVersionSelect value={pick} onChange={setPick} allowNone noneLabel="No resume (profile skills only)" autoSelect={!report} />
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-8">
      {error ? <ErrorState error={error} title="Could not work out your match" /> : null}

      {!report ? (
        <>
          {resumeBar}
          <EmptyState title={busy ? "Working out your match…" : "No match yet"}>
            {busy ? "This takes a second." : "Upload your resume in step 1 (My resume), then press Update score."}
          </EmptyState>
        </>
      ) : r ? (
        <>
          {/* 1 — the answer */}
          <section aria-labelledby="score-h" className="rounded-2xl border border-line bg-surface p-5 sm:p-7 shadow-[0_18px_50px_-30px_rgba(15,29,51,0.45)]">
            <div className="flex flex-col sm:flex-row sm:items-center gap-6">
              <ScoreRing value={cov} tone={v.tone} />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted">Your match score</p>
                <h2 id="score-h" className="serif text-3xl sm:text-[34px] leading-tight mt-1">{v.title}</h2>
                <p className="mt-2 text-[15px] text-ink-2 max-w-xl">{withheld ? r.summary.withheld_reason : v.text}</p>
                <ul className="mt-4 flex flex-wrap gap-2" aria-label="Summary">
                  <li><Badge tone="ok" icon={<CheckCircle2 aria-hidden className="size-3.5" />}>{count("have")} you have</Badge></li>
                  {count("partly") ? <li><Badge tone="warn" icon={<CircleMinus aria-hidden className="size-3.5" />}>{count("partly")} partly</Badge></li> : null}
                  {count("missing") ? <li><Badge tone="danger" icon={<XCircle aria-hidden className="size-3.5" />}>{count("missing")} missing</Badge></li> : null}
                  {count("check") ? <li><Badge icon={<CircleHelp aria-hidden className="size-3.5" />}>{count("check")} to confirm</Badge></li> : null}
                  {count("soft") ? <li><Badge tone="accent" icon={<MessageCircle aria-hidden className="size-3.5" />}>{count("soft")} soft skills</Badge></li> : null}
                </ul>
              </div>
            </div>
            <p className="mt-5 border-t border-line pt-3 text-[12.5px] text-muted">
              The score is the share of this job&apos;s <b>required</b> skills your resume shows. It isn&apos;t a hiring prediction.
            </p>
          </section>

          {resumeBar}

          {/* 2 — what to do next */}
          <section aria-labelledby="next-h">
            <h2 id="next-h" className="serif text-2xl">What to do next</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <NextCard n={1} icon={<Wand2 aria-hidden className="size-5" />} title="Get a tailored resume"
                text="A one-page resume for this job in a professional template, as a PDF or LaTeX file."
                action="Generate resume" onClick={() => onGoTo?.("resume")} />
              <NextCard n={2} icon={<FileText aria-hidden className="size-5" />} title="Improve your resume"
                text={missingSkills.length ? `Add proof of ${missingSkills.join(", ")} if you have it, and fix wording.` : "Tighten wording and make your skills easy to spot."}
                action="Open resume tips" onClick={() => onGoTo?.("guidance")} />
              <NextCard n={3} icon={<MessagesSquare aria-hidden className="size-5" />} title="Practise the interview"
                text="Likely questions for this role, plus what past candidates were asked."
                action="Start practising" onClick={() => onGoTo?.("interview")} />
              <NextCard n={4} icon={<Sparkles aria-hidden className="size-5" />} title="Ask AI about this job"
                text="Ask anything — what to learn first, how to answer, what the role involves."
                action="Ask a question" onClick={() => onGoTo?.("ask")} />
            </div>
          </section>

          {/* 3 — the checklist */}
          <section aria-labelledby="list-h" className="flex flex-col gap-6">
            <h2 id="list-h" className="serif text-2xl">Requirement by requirement</h2>
            {BUCKETS.map((b) => {
              const items = byBucket(b.id);
              if (!items.length) return null;
              const Icon = b.icon;
              return (
                <div key={b.id} className="rounded-2xl border border-line bg-surface">
                  <div className="px-5 pt-4 pb-3 border-b border-line">
                    <h3 className={cx("flex items-center gap-2 font-semibold", b.tone)}>
                      <Icon aria-hidden className="size-5" />{b.title}<span className="text-muted font-normal">({items.length})</span>
                    </h3>
                    <p className="mt-1 text-[13px] text-muted">{b.hint}</p>
                  </div>
                  <ul className="divide-y divide-line">
                    {items.map((u) => <UnitRow key={u.key} u={u} confirming={confirming} onConfirm={confirm} />)}
                  </ul>
                </div>
              );
            })}
          </section>

          {r.conditions.length || r.excluded.length ? (
            <details className="rounded-2xl border border-line bg-surface px-5 py-4 group">
              <summary className="cursor-pointer font-medium text-ink-2 flex items-center gap-2">
                <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />More details (location, items not counted)
              </summary>
              {r.conditions.length ? (
                <div className="mt-4">
                  <p className="text-sm font-medium">Location and work conditions — not part of the score</p>
                  <ul className="mt-2 divide-y divide-line border-y border-line">
                    {r.conditions.map((c) => (
                      <li key={c.key} className="py-3">
                        <p className="text-sm text-ink break-words">&ldquo;{c.text}&rdquo;</p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {c.user_confirmation ? (
                            <StatusLabel status={c.user_confirmation.met ? "user_confirmed" : "not_met_confirmed"} />
                          ) : <span className="text-[13px] text-muted">Not answered</span>}
                          <Button size="sm" variant="ghost" loading={confirming === c.key + "true"} onClick={() => confirm(c, true)}>Works for me</Button>
                          <Button size="sm" variant="ghost" loading={confirming === c.key + "false"} onClick={() => confirm(c, false)}>Doesn&apos;t</Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {r.excluded.length ? (
                <div className="mt-4">
                  <p className="text-sm font-medium">Not counted</p>
                  <ul className="mt-2 flex flex-col gap-1.5 text-sm">
                    {r.excluded.map((x) => <li key={x.key} className="text-ink-2 break-words">&ldquo;{x.text}&rdquo; — <span className="text-muted">{x.reason}</span></li>)}
                  </ul>
                </div>
              ) : null}
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function NextCard({ n, icon, title, text, action, onClick }: { n: number; icon: ReactNode; title: string; text: string; action: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="group text-left rounded-2xl border border-line bg-surface p-4 flex flex-col gap-2 transition hover:border-accent/50 hover:shadow-[0_10px_30px_-18px_rgba(15,29,51,0.45)] focus-visible:outline-2 focus-visible:outline-accent">
      <span className="flex items-center gap-2 text-accent">
        <span className="grid place-items-center size-9 rounded-xl bg-accent-soft">{icon}</span>
        <span className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">Step {n}</span>
      </span>
      <span className="font-semibold text-ink">{title}</span>
      <span className="text-[13.5px] text-ink-2 flex-1">{text}</span>
      <span className="inline-flex items-center gap-1 text-sm font-medium text-accent">
        {action}<ArrowRight aria-hidden className="size-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

function UnitRow({ u, confirming, onConfirm }: { u: MatchUnit; confirming: string | null; onConfirm: (u: MatchUnit, met: boolean) => void }) {
  const found = [...new Set(u.evidence.map((e) => e.label))];
  const anyOf = u.group === "any" && u.concepts.length > 1;
  return (
    <li className="px-5 py-4 flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2">
        <p className="text-[15px] text-ink break-words flex-1 min-w-[12rem]">{u.text}</p>
        {u.importance !== "required" ? <Badge>{u.importance === "unclear" ? "Not sure if required" : "Nice to have"}</Badge> : <Badge tone="accent">Required</Badge>}
      </div>
      {found.length ? (
        <p className="text-[13px] text-ink-2"><span className="text-ok font-medium">Found in your resume:</span> {found.join(", ")}</p>
      ) : null}
      {u.adjacent.length ? (
        <p className="text-[13px] text-ink-2">You have a related skill: {u.adjacent.map((a) => a.label).join(", ")}</p>
      ) : null}
      {u.missing.length && !(anyOf && found.length) ? (
        <p className="text-[13px] text-ink-2">
          <span className="text-danger font-medium">{anyOf ? "Any one of these would count:" : "Not found:"}</span> {u.missing.map((m) => m.label).join(", ")}
        </p>
      ) : null}
      {u.status === "soft_skill" ? (
        <p className="text-[13px] text-ink-2">Prepare one short story (situation → what you did → result) that shows this.</p>
      ) : null}
      {u.status === "unassessable" || u.rule === "R3" ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Do you meet this requirement?">
          <Button size="sm" variant={u.status === "user_confirmed" ? "primary" : "secondary"} loading={confirming === u.key + "true"} onClick={() => onConfirm(u, true)}>
            <CheckCircle2 aria-hidden className="size-3.5" />I have this
          </Button>
          <Button size="sm" variant="ghost" loading={confirming === u.key + "false"} onClick={() => onConfirm(u, false)}>I don&apos;t</Button>
        </div>
      ) : null}
    </li>
  );
}
