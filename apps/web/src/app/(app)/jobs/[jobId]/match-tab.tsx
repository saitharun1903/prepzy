"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2, CircleDashed, CircleHelp, CircleMinus, CircleSlash, MinusCircle, RefreshCw, UserCheck, XCircle,
} from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { formatDateTime, humanize, months } from "@/lib/format";
import type { MatchReport, MatchStatus, MatchUnit } from "@/lib/types";
import { ResumeVersionSelect, type VersionPick } from "@/components/resume-version-select";
import { Badge, Button, EmptyState, ErrorState, LoadingBlock, Notice, SectionTitle, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { addCorrection } from "./shared";

const STATUS: Record<MatchStatus, { label: string; icon: typeof CheckCircle2; tone: string }> = {
  supported: { label: "Supported by resume", icon: CheckCircle2, tone: "text-ok" },
  user_confirmed: { label: "Confirmed by you", icon: UserCheck, tone: "text-ok" },
  partial: { label: "Partly evidenced", icon: CircleMinus, tone: "text-warn" },
  adjacent: { label: "Related skill only", icon: CircleDashed, tone: "text-warn" },
  not_evidenced: { label: "Not evidenced", icon: XCircle, tone: "text-danger" },
  not_met_confirmed: { label: "You said not met", icon: CircleSlash, tone: "text-danger" },
  unassessable: { label: "Can't be assessed", icon: CircleHelp, tone: "text-muted" },
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

function Coverage({ title, s, withheld }: { title: string; s: MatchReport["result"]["summary"]["required"]; withheld: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-sm text-muted">{title}</p>
      {s.total === 0 ? (
        <p className="mt-1 text-sm text-ink-2">None identified</p>
      ) : withheld || s.coverage === null ? (
        <p className="mt-1 text-sm text-ink-2">No estimate</p>
      ) : (
        <p className="mt-1 serif text-4xl leading-none">{Math.round(s.coverage)}<span className="text-xl text-muted">%</span></p>
      )}
      <p className="mt-2 text-[13px] text-ink-2">
        {s.total} item{s.total === 1 ? "" : "s"} · {s.assessable} assessable
        {s.completeness !== null ? ` · ${Math.round(s.completeness * 100)}% complete` : ""}
      </p>
    </div>
  );
}

export function MatchTab({ jobId, hasAnalysis, onJobChanged }: { jobId: string; hasAnalysis: boolean; onJobChanged: () => void }) {
  const { notify } = useToast();
  const [report, setReport] = useState<MatchReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [pick, setPick] = useState<VersionPick>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);

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

  const compute = async (versionId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<MatchReport>(`jobs/${jobId}/match`, { method: "POST", body: { resume_version_id: versionId } });
      setReport(r);
      notify("ok", r.reused ? "Inputs unchanged — showing the existing report" : "Comparison updated");
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (u: { key: string }, met: boolean) => {
    if (!report) return;
    setConfirming(u.key + String(met));
    try {
      await addCorrection(jobId, { analysis_id: report.result.inputs.analysis_id, target: "confirmation", key: u.key, value: { met } });
      onJobChanged();
      await compute(report.result.resume?.version_id ?? null);
    } catch (e) {
      notify("error", (e as ApiError).message);
    } finally {
      setConfirming(null);
    }
  };

  if (!hasAnalysis) return <EmptyState title="Analyse the job first">A comparison needs the job&apos;s requirements.</EmptyState>;
  if (loading) return <LoadingBlock rows={3} label="Loading comparison" />;

  const r = report?.result;
  const withheld = r?.summary.score_status === "withheld";
  const groups = r ? (["required", "preferred", "unclear"] as const).map((imp) => ({
    imp, items: r.requirements.filter((u) => u.importance === imp || (imp === "preferred" && u.importance === "optional")),
  })).filter((g) => g.items.length) : [];

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="compare-h" className="rounded-lg border border-line bg-surface p-4 flex flex-col gap-3">
        <SectionTitle id="compare-h">Compare with a resume</SectionTitle>
        {picked ? (
          <ResumeVersionSelect value={pick} onChange={setPick} allowNone noneLabel="No resume (profile skills only)" autoSelect={!report} />
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy} onClick={() => compute(pick?.versionId ?? null)}>
            {report ? "Compare again" : "Compare"}
          </Button>
        </div>
        <p className="text-[13px] text-muted">Matching is deterministic and runs instantly. It uses your resume evidence and confirmed profile skills only.</p>
      </section>

      {error ? <ErrorState error={error} title="Could not compute the comparison" /> : null}

      {!report ? (
        <EmptyState title="No comparison yet">Choose a resume version and compare.</EmptyState>
      ) : r ? (
        <>
          {report.stale_reasons.length ? (
            <Notice tone="warn" title="This report may be out of date">
              <ul className="list-disc pl-5">{report.stale_reasons.map((s, i) => <li key={i}>{s}</li>)}</ul>
              <Button size="sm" className="mt-2" loading={busy} onClick={() => compute(r.resume?.version_id ?? null)}>
                <RefreshCw aria-hidden className="size-3.5" />Recompute
              </Button>
            </Notice>
          ) : null}

          <section aria-labelledby="estimate-h">
            <h2 id="estimate-h" className="serif text-2xl">{r.label}</h2>
            <p className="mt-1 text-sm text-ink-2 max-w-2xl">{r.disclaimer}</p>
            <p className="mt-1 text-[13px] text-muted">
              Computed {formatDateTime(report.created_at)} · scoring {r.scoring_version}
              {r.resume ? ` · resume version ${r.resume.version}` : " · no resume"}
            </p>
            {withheld ? (
              <Notice tone="info" className="mt-4" title="Estimate withheld">{r.summary.withheld_reason}</Notice>
            ) : null}
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Coverage title="Required qualifications" s={r.summary.required} withheld={withheld} />
              <Coverage title="Preferred qualifications" s={r.summary.preferred} withheld={withheld} />
            </div>
            <p className="mt-3 text-[13px] text-muted">
              Evidence used: {r.evidence_basis.resume_skills} resume skill{r.evidence_basis.resume_skills === 1 ? "" : "s"},{" "}
              {r.evidence_basis.profile_skills} confirmed profile skill{r.evidence_basis.profile_skills === 1 ? "" : "s"}, dated experience{" "}
              {r.evidence_basis.experience_months === null ? "not found" : months(r.evidence_basis.experience_months)} (overlaps counted once).
            </p>
          </section>

          {groups.map((g) => (
            <section key={g.imp} aria-labelledby={`m-${g.imp}`}>
              <SectionTitle id={`m-${g.imp}`}>{humanize(g.imp)} ({g.items.length})</SectionTitle>
              <ul className="divide-y divide-line border-y border-line">
                {g.items.map((u) => <UnitRow key={u.key} u={u} confirming={confirming} onConfirm={confirm} />)}
              </ul>
            </section>
          ))}

          {r.conditions.length ? (
            <section aria-labelledby="m-cond">
              <SectionTitle id="m-cond">Conditions (not scored)</SectionTitle>
              <p className="text-[13px] text-muted mb-2">Location, work arrangement and authorisation are shown for your review and never affect the estimate.</p>
              <ul className="divide-y divide-line border-y border-line">
                {r.conditions.map((c) => (
                  <li key={c.key} className="py-3">
                    <p className="text-sm text-ink break-words">&ldquo;{c.text}&rdquo;</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {c.user_confirmation ? (
                        <StatusLabel status={c.user_confirmation.met ? "user_confirmed" : "not_met_confirmed"} />
                      ) : <span className="text-[13px] text-muted">Not confirmed</span>}
                      <Button size="sm" variant="ghost" loading={confirming === c.key + "true"} onClick={() => confirm(c, true)}>I meet this</Button>
                      <Button size="sm" variant="ghost" loading={confirming === c.key + "false"} onClick={() => confirm(c, false)}>I don&apos;t</Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {r.priorities.length ? (
            <section aria-labelledby="m-prio">
              <SectionTitle id="m-prio">Priorities to work on</SectionTitle>
              <ul className="flex flex-wrap gap-2">
                {r.priorities.map((p) => (
                  <li key={p.concept_id}>
                    <Badge tone={p.priority === "high" ? "danger" : p.priority === "medium" ? "warn" : "neutral"}>
                      {p.label} · {p.priority} priority{p.adjacent ? " · related skill found" : ""}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {r.excluded.length ? (
            <section aria-labelledby="m-excl">
              <SectionTitle id="m-excl">Excluded from the estimate</SectionTitle>
              <ul className="flex flex-col gap-2 text-sm">
                {r.excluded.map((x) => (
                  <li key={x.key} className="flex flex-wrap gap-2"><MinusCircle aria-hidden className="size-4 text-muted mt-0.5" />
                    <span className="text-ink-2 break-words min-w-0 flex-1">&ldquo;{x.text}&rdquo; — <span className="text-muted">{x.reason}</span></span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function UnitRow({ u, confirming, onConfirm }: { u: MatchUnit; confirming: string | null; onConfirm: (u: MatchUnit, met: boolean) => void }) {
  return (
    <li className="py-4 grid gap-2 sm:grid-cols-[200px_1fr]">
      <div><StatusLabel status={u.status} /></div>
      <div className="min-w-0">
        <p className="text-sm text-ink break-words">&ldquo;{u.text}&rdquo;</p>
        {u.group === "any" && u.concepts.length > 1 ? <p className="text-[13px] text-muted mt-1">Any one of: {u.concepts.map((c) => c.label).join(" OR ")}</p> : null}
        {u.evidence.length ? (
          <ul className="mt-2 flex flex-col gap-1.5">
            {u.evidence.map((e, i) => (
              <li key={i} className="text-[13px]">
                <span className="font-medium text-ink">{e.label}</span>
                <span className="text-muted"> · {humanize(e.type)} · from {e.source === "profile" ? "your profile" : e.source === "user_review" ? "your resume review" : "resume"}</span>
                {e.excerpt ? <blockquote className="mt-0.5 border-l-2 border-line-strong pl-2 text-ink-2 break-words">{e.excerpt}</blockquote> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {u.adjacent.length ? (
          <p className="mt-1 text-[13px] text-ink-2">Related evidence: {u.adjacent.map((a) => a.label).join(", ")} (counts as 25%)</p>
        ) : null}
        {u.missing.length && !(u.group === "any" && (u.status === "supported" || u.status === "user_confirmed")) ? (
          <p className="mt-1 text-[13px] text-ink-2">{u.group === "any" ? "No evidence for" : "Missing"}: {u.missing.map((m) => m.label).join(", ")}</p>
        ) : null}
        {u.notes.length ? <ul className="mt-1 text-[13px] text-muted list-disc pl-5">{u.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
        {u.status === "unassessable" || u.rule === "R3" ? (
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Confirm this requirement">
            <Button size="sm" loading={confirming === u.key + "true"} onClick={() => onConfirm(u, true)}>I meet this</Button>
            <Button size="sm" loading={confirming === u.key + "false"} onClick={() => onConfirm(u, false)}>I don&apos;t</Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}
