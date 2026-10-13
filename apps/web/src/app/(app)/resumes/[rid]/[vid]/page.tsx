"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { AlertTriangle, Info, Undo2, X } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { EVIDENCE_TYPES, formatDateTime, humanize, months } from "@/lib/format";
import type { ResumeVersionDetail, SkillHit } from "@/lib/types";
import { SkillPicker } from "@/components/skill-picker";
import {
  Badge, Button, ErrorState, Field, Input, LoadingBlock, Notice, PageHeader, SectionTitle, Select,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";

type Review = { removed: string[]; added: { id: string; label: string; evidence_type: string }[]; months: string };

export default function ResumeVersionPage({ params }: { params: Promise<{ rid: string; vid: string }> }) {
  const { rid, vid } = use(params);
  const { notify } = useToast();
  const d = useApi<ResumeVersionDetail>(`resumes/${rid}/versions/${vid}`);
  const [review, setReview] = useState<Review | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (!d.data || dirty) return;
    const rv = d.data.version.reviewed;
    const labels = new Map(d.data.version.effective_skills.map((s) => [s.id, s.label]));
    setReview({
      removed: rv?.removed_skills || [],
      added: (rv?.added_skills || []).map((a) => ({ id: a.id, label: labels.get(a.id) || a.id, evidence_type: a.evidence_type || "self_reported" })),
      months: rv?.experience_months_override != null ? String(rv.experience_months_override) : "",
    });
  }, [d.data, dirty]);

  if (d.loading && !d.data) return <LoadingBlock rows={5} label="Loading resume version" />;
  if (d.error) return <ErrorState error={d.error} onRetry={d.reload} title="Could not load this resume version" />;
  if (!d.data || !review) return null;
  const { resume, version, ats_findings } = d.data;
  const ex = version.extracted;

  const update = (r: Review) => { setReview(r); setDirty(true); };

  const save = async (force = false) => {
    setBusy(true);
    setError(null);
    try {
      let expected = version.reviewed_at;
      if (force) {
        const latest = await apiFetch<ResumeVersionDetail>(`resumes/${rid}/versions/${vid}`);
        expected = latest.version.reviewed_at;
      }
      const m = review.months.trim();
      await apiFetch(`resumes/${rid}/versions/${vid}/review`, {
        method: "PUT",
        body: {
          removed_skills: review.removed,
          added_skills: review.added.map((a) => ({ id: a.id, evidence_type: a.evidence_type })),
          experience_months_override: m === "" ? null : Math.max(0, Math.min(720, Math.round(Number(m)))),
          expected_reviewed_at: expected,
        },
      });
      notify("ok", "Review saved");
      setDirty(false);
      setConflict(false);
      d.reload();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "stale_write") setConflict(true);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/resumes" className="hover:underline underline-offset-4">Resumes</Link>}
        title={`${resume.name} · version ${version.version}`}
        description={
          <span className="text-sm">
            {version.origin === "upload" ? version.original_filename : version.origin === "edited" ? "Edited text version" : "Pasted text"} · added {formatDateTime(version.created_at)}
            {version.reviewed_at ? ` · reviewed ${formatDateTime(version.reviewed_at)}` : ""}
          </span>
        }
      />

      {!ex ? (
        <Notice tone="warn" title="No extracted evidence">This version has not been parsed ({humanize(version.parse_status)}). {version.parse_error}</Notice>
      ) : (
        <div className="flex flex-col gap-12">
          {ex.warnings.length ? (
            <Notice tone="warn" title="Parser warnings">
              <ul className="list-disc pl-5">{ex.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </Notice>
          ) : null}

          <section aria-labelledby="skills-h">
            <SectionTitle id="skills-h">Skills found ({ex.skills.length})</SectionTitle>
            <p className="text-[13px] text-muted mb-3">Evidence type comes from the section the skill appears in: professional (Experience), project (Projects), certification, or listed (mentioned only). Remove anything that is wrong.</p>
            {ex.skills.length ? (
              <ul className="divide-y divide-line border-y border-line">
                {ex.skills.map((s) => {
                  const removed = review.removed.includes(s.id);
                  return (
                    <li key={s.id} className={`py-2.5 flex flex-wrap items-center gap-2 ${removed ? "opacity-60" : ""}`}>
                      <span className={`font-medium ${removed ? "line-through" : ""}`}>{s.label}</span>
                      <Badge tone={s.evidence_type === "listed" ? "neutral" : "accent"}>{humanize(s.evidence_type)}</Badge>
                      <span className="text-[13px] text-muted">in {s.sections.map(humanize).join(", ")} · {s.mentions} mention{s.mentions === 1 ? "" : "s"}</span>
                      {removed ? <Badge tone="warn">Removed by you</Badge> : null}
                      <Button size="sm" variant="ghost" className="ml-auto"
                        onClick={() => update({ ...review, removed: removed ? review.removed.filter((x) => x !== s.id) : [...review.removed, s.id] })}>
                        {removed ? <><Undo2 aria-hidden className="size-3.5" />Restore</> : <><X aria-hidden className="size-3.5" />Remove</>}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="text-sm text-muted">No taxonomy skills were found in this text.</p>}
          </section>

          <section aria-labelledby="add-h">
            <SectionTitle id="add-h">Skills you add to this version</SectionTitle>
            <p className="text-[13px] text-muted mb-3">Added skills are labelled as coming from your review, not the resume text.</p>
            <div className="max-w-md">
              <SkillPicker label="Add a skill" exclude={[...ex.skills.map((s) => s.id), ...review.added.map((a) => a.id)]}
                onPick={(h: SkillHit) => update({ ...review, added: [...review.added, { id: h.id, label: h.label, evidence_type: "self_reported" }] })} />
            </div>
            {review.added.length ? (
              <ul className="mt-3 divide-y divide-line border-y border-line">
                {review.added.map((a) => (
                  <li key={a.id} className="py-2.5 flex flex-wrap items-center gap-3">
                    <span className="font-medium">{a.label}</span>
                    <label className="sr-only" htmlFor={`ev-${a.id}`}>Evidence type for {a.label}</label>
                    <Select id={`ev-${a.id}`} className="w-auto h-8" value={a.evidence_type}
                      onChange={(e) => update({ ...review, added: review.added.map((x) => x.id === a.id ? { ...x, evidence_type: e.target.value } : x) })}>
                      {EVIDENCE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </Select>
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={() => update({ ...review, added: review.added.filter((x) => x.id !== a.id) })}>
                      <X aria-hidden className="size-3.5" />Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section aria-labelledby="exp-h">
            <SectionTitle id="exp-h">Experience</SectionTitle>
            <p className="text-sm text-ink-2 mb-3">
              Total dated experience: <strong className="font-medium text-ink">{months(ex.experience_months)}</strong>{" "}
              <span className="text-muted">(overlapping periods are counted once)</span>
            </p>
            {ex.experience.length ? (
              <ul className="divide-y divide-line border-y border-line mb-4">
                {ex.experience.map((e, i) => (
                  <li key={i} className="py-2.5 text-sm">
                    <p className="break-words">{e.line}</p>
                    <p className="text-[13px] text-muted">{e.start} → {e.end}</p>
                    {e.issue ? <p className="text-[13px] text-danger flex items-center gap-1"><AlertTriangle aria-hidden className="size-3.5" />{e.issue}</p> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted mb-4">No dated experience entries were found under an Experience heading.</p>}
            <div className="max-w-xs">
              <Field label="Override total months (optional)" hint="Use if the calculation above is wrong. Leave empty to use the calculated value.">
                {(p) => <Input id={p.id} type="number" min={0} max={720} inputMode="numeric" value={review.months} onChange={(e) => update({ ...review, months: e.target.value })} aria-describedby={p.describedBy} />}
              </Field>
            </div>
          </section>

          <section aria-labelledby="save-h" className="sticky bottom-20 lg:bottom-4 z-10">
            <h2 id="save-h" className="sr-only">Save review</h2>
            {conflict ? (
              <Notice tone="warn" title="This review was changed elsewhere" className="mb-2">
                Your edits are kept here. Save them over the newer review, or discard and reload.
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" loading={busy} onClick={() => save(true)}>Save mine anyway</Button>
                  <Button size="sm" onClick={() => { setDirty(false); setConflict(false); d.reload(); }}>Discard and reload</Button>
                </div>
              </Notice>
            ) : null}
            {error ? <div className="mb-2"><ErrorState error={error} title="Could not save the review" /></div> : null}
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-sm">
              <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => save(false)}>Save review</Button>
              <span className="text-[13px] text-muted" aria-live="polite">{dirty ? "Unsaved changes" : "No unsaved changes"}</span>
              <span className="text-[13px] text-muted">Saving marks existing job comparisons as out of date.</span>
            </div>
          </section>

          <section aria-labelledby="edu-h" className="grid gap-8 sm:grid-cols-2">
            <div>
              <SectionTitle id="edu-h">Education</SectionTitle>
              {ex.education.length ? <ul className="flex flex-col gap-1.5 text-sm">{ex.education.map((e, i) => <li key={i} className="break-words">{e.text}</li>)}</ul> : <p className="text-sm text-muted">No Education section found.</p>}
            </div>
            <div>
              <SectionTitle>Certifications</SectionTitle>
              {ex.certifications.length ? <ul className="flex flex-col gap-1.5 text-sm">{ex.certifications.map((e, i) => <li key={i} className="break-words">{e.text}</li>)}</ul> : <p className="text-sm text-muted">No Certifications section found.</p>}
            </div>
          </section>

          <section aria-labelledby="ats-h">
            <SectionTitle id="ats-h">Readability checks</SectionTitle>
            <p className="text-[13px] text-muted mb-3">Explainable checks only. Not an employer ATS score.</p>
            {ats_findings.length ? (
              <ul className="divide-y divide-line border-y border-line">
                {ats_findings.map((f) => (
                  <li key={f.id} className="py-3 flex items-start gap-3">
                    {f.severity === "high" || f.severity === "medium" ? <AlertTriangle aria-hidden className="size-4 text-warn mt-0.5 shrink-0" /> : <Info aria-hidden className="size-4 text-info mt-0.5 shrink-0" />}
                    <div className="min-w-0">
                      <p className="text-sm break-words">{f.message}</p>
                      <p className="text-[13px] text-muted">{f.why} · {humanize(f.severity)} severity</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted">No findings.</p>}
          </section>

          {version.text ? (
            <section aria-labelledby="text-h">
              <SectionTitle id="text-h">Extracted text</SectionTitle>
              <div className="rounded-lg border border-line bg-surface p-4 max-h-[60vh] overflow-auto">
                <p className="prewrap text-[13px] font-mono text-ink-2">{version.text}</p>
              </div>
            </section>
          ) : null}
        </div>
      )}
    </>
  );
}
