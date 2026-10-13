"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { useApi, useBeforeUnload } from "@/lib/hooks";
import { humanize } from "@/lib/format";
import type { Accepted, ResumeVersionDetail, SuggestResult } from "@/lib/types";
import { ResumeVersionSelect, type VersionPick } from "@/components/resume-version-select";
import { OperationStatus } from "@/components/operation-status";
import { Badge, Button, Checkbox, EmptyState, ErrorState, LoadingBlock, Notice, SectionTitle, Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { MODEL } from "@/lib/hosting";

export function GuidanceTab({ jobId }: { jobId: string }) {
  const [pick, setPick] = useState<VersionPick>(null);
  return (
    <div className="flex flex-col gap-8">
      <ResumeVersionSelect value={pick} onChange={setPick} label="Resume version to review" />
      {pick ? <Guidance key={pick.versionId} jobId={jobId} pick={pick} /> : null}
    </div>
  );
}

function Guidance({ jobId, pick }: { jobId: string; pick: NonNullable<VersionPick> }) {
  const { notify } = useToast();
  const v = useApi<ResumeVersionDetail>(`resumes/${pick.resumeId}/versions/${pick.versionId}`, { job_id: jobId });
  const [opId, setOpId] = useState<string | null>(null);
  const [result, setResult] = useState<SuggestResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState<{ resume_id: string; version_id: string } | null>(null);

  const original = v.data?.version.text ?? "";
  useEffect(() => {
    if (v.data && draft === null) setDraft(v.data.version.text ?? "");
  }, [v.data, draft]);
  const dirty = draft !== null && draft !== original && !saved;
  useBeforeUnload(dirty);

  const suggest = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await apiFetch<Accepted>(`resumes/${pick.resumeId}/versions/${pick.versionId}/suggestions`, {
        method: "POST", body: { job_id: jobId }, idempotencyKey: newIdempotencyKey(),
      });
      setOpId(r.operation_id);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const applySelected = () => {
    if (!result || draft === null) return;
    let text = draft;
    let applied = 0;
    const missing: number[] = [];
    result.suggestions.forEach((s, i) => {
      if (!selected.has(i)) return;
      const at = text.indexOf(s.original);
      if (at === -1) { missing.push(i + 1); return; }
      text = text.slice(0, at) + s.suggested + text.slice(at + s.original.length);
      applied++;
    });
    setDraft(text);
    notify(missing.length ? "info" : "ok", `Applied ${applied} suggestion${applied === 1 ? "" : "s"} to the draft`,
      missing.length ? `Not applied (original line already edited): ${missing.join(", ")}` : undefined);
  };

  const saveVersion = async () => {
    if (!draft || !v.data) return;
    setBusy(true);
    setError(null);
    try {
      const out = await apiFetch<{ resume_id: string; version_id: string }>("resumes/text", {
        method: "POST",
        body: { resume_id: pick.resumeId, text: draft, origin: "edited", based_on_version_id: pick.versionId, name: v.data.resume.name },
      });
      setSaved(out);
      notify("ok", "Saved as a new resume version");
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (v.loading && !v.data) return <LoadingBlock rows={3} label="Loading resume" />;
  if (v.error) return <ErrorState error={v.error} onRetry={v.reload} title="Could not load this resume version" />;
  if (!v.data) return null;

  const findings = v.data.ats_findings;
  return (
    <>
      <section aria-labelledby="ats-h">
        <SectionTitle id="ats-h">Readability checks</SectionTitle>
        <p className="text-[13px] text-muted mb-3">Explainable checks of structure and content. This is not a reproduction of any employer&apos;s ATS and has no single score.</p>
        {findings.length ? (
          <ul className="divide-y divide-line border-y border-line">
            {findings.map((f) => (
              <li key={f.id} className="py-3 flex items-start gap-3">
                {f.severity === "high" || f.severity === "medium" ? <AlertTriangle aria-hidden className="size-4 text-warn mt-0.5 shrink-0" /> : <Info aria-hidden className="size-4 text-info mt-0.5 shrink-0" />}
                <div className="min-w-0">
                  <p className="text-sm text-ink break-words">{f.message}</p>
                  <p className="text-[13px] text-muted mt-0.5">{f.why}</p>
                  <div className="mt-1 flex gap-1.5"><Badge>{humanize(f.severity)} severity</Badge><Badge>{humanize(f.category)}</Badge></div>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted">No findings for this version.</p>}
      </section>

      <section aria-labelledby="sugg-h">
        <SectionTitle id="sugg-h">Wording suggestions</SectionTitle>
        <p className="text-[13px] text-muted mb-3">{MODEL === "the AI model" ? "The AI model" : "The local model"} rewrites selected lines using only facts already in that line. Suggestions that add numbers, tools or names are rejected automatically.</p>
        <Button variant="primary" loading={busy && !opId} disabled={Boolean(opId) && !result} onClick={suggest}>Suggest improvements</Button>
        {opId ? (
          <div className="mt-3">
            <OperationStatus<SuggestResult> opId={opId} label="Resume suggestions" onDone={(op) => {
              if (op.result && "suggestions" in op.result) { setResult(op.result); setSelected(new Set()); }
              setOpId(null);
            }} />
          </div>
        ) : null}
        {error ? <div className="mt-3"><ErrorState error={error} /></div> : null}
        {result ? (
          <div className="mt-5 flex flex-col gap-4">
            <Notice tone="info">{result.note}{result.rejected_count ? ` ${result.rejected_count} suggestion(s) were rejected by validation.` : ""}</Notice>
            {!result.suggestions.length ? <EmptyState title="No usable suggestions">Try again later, or edit the draft yourself.</EmptyState> : (
              <ul className="flex flex-col gap-3">
                {result.suggestions.map((s, i) => (
                  <li key={i} className="rounded-lg border border-line bg-surface p-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div><p className="text-[12px] uppercase tracking-wide text-muted mb-1">Before</p><p className="text-sm text-ink-2 prewrap">{s.original}</p></div>
                      <div><p className="text-[12px] uppercase tracking-wide text-muted mb-1">After</p><p className="text-sm text-ink prewrap">{s.suggested}</p></div>
                    </div>
                    <p className="text-[13px] text-ink-2 mt-2">Why: {s.reason}</p>
                    {s.needs_evidence ? <Notice tone="warn" className="mt-2">Needs your input: {s.needs_evidence}</Notice> : null}
                    <Checkbox className="mt-3" checked={selected.has(i)} label="Accept this suggestion"
                      onChange={(e) => setSelected((cur) => { const n = new Set(cur); if (e.target.checked) n.add(i); else n.delete(i); return n; })} />
                  </li>
                ))}
              </ul>
            )}
            {result.suggestions.length ? <div><Button onClick={applySelected} disabled={!selected.size}>Apply {selected.size || ""} selected to the draft</Button></div> : null}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="draft-h">
        <SectionTitle id="draft-h">Edit and save as a new version</SectionTitle>
        <Notice tone="info" className="mb-3">
          This creates a new <strong className="font-medium">text</strong> version of your resume. It does not keep the original PDF or DOCX
          layout, and your original version stays unchanged.
        </Notice>
        <label htmlFor="resume-draft" className="sr-only">Resume draft text</label>
        <Textarea id="resume-draft" rows={18} value={draft ?? ""} onChange={(e) => { setDraft(e.target.value); setSaved(null); }} className="font-mono text-[13px]" />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={saveVersion} loading={busy && !opId} disabled={!dirty || (draft ?? "").trim().length < 100}>Save as new version</Button>
          {dirty ? <Button variant="ghost" onClick={() => setDraft(original)}>Discard edits</Button> : null}
          {dirty ? <span className="text-[13px] text-muted" aria-live="polite">Unsaved edits</span> : null}
          {saved ? (
            <Link href={`/resumes/${saved.resume_id}/${saved.version_id}`} className="text-sm text-accent underline underline-offset-4">Open the new version</Link>
          ) : null}
        </div>
      </section>
    </>
  );
}
