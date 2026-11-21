"use client";

import { useState } from "react";
import { AlertTriangle, Pencil, Undo2 } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { formatDateTime, humanize } from "@/lib/format";
import type { AnalysisField, JobDetail } from "@/lib/types";
import { OperationStatus } from "@/components/operation-status";
import {
  Badge, Button, DefinitionList, EmptyState, ErrorState, Field, Input, Notice, SectionTitle, Select, Textarea,
} from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { EvidenceToggle, FIELD_LABELS, SourceBadge, addCorrection, revertCorrection } from "./shared";

export function OverviewTab({ detail, reload, analysisId, setAnalysisId }: {
  detail: JobDetail; reload: () => void; analysisId: string | null; setAnalysisId: (id: string | null) => void;
}) {
  const { notify } = useToast();
  const a = detail.analysis;
  const [showEmpty, setShowEmpty] = useState(false);
  const [editing, setEditing] = useState<{ key: string; field: AnalysisField } | null>(null);
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const saveField = async () => {
    if (!a || !editing) return;
    setBusy(true);
    setError(null);
    try {
      await addCorrection(detail.job.id, { analysis_id: a.id, target: "field", key: editing.key, value: { value: value.trim() || null }, note: note.trim() || null });
      notify("ok", `${FIELD_LABELS[editing.key] || editing.key} corrected`);
      setEditing(null);
      reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const revert = async (key: string, cid: string) => {
    try {
      await revertCorrection(detail.job.id, cid);
      notify("ok", `${FIELD_LABELS[key] || key} reverted to the analysed value`);
      reload();
    } catch (e) {
      notify("error", (e as ApiError).message);
    }
  };

  const setAvailability = async (v: string) => {
    try {
      await apiFetch(`jobs/${detail.job.id}`, { method: "PATCH", body: { availability: v } });
      notify("ok", "Availability updated");
      reload();
    } catch (e) {
      notify("error", (e as ApiError).message);
    }
  };

  return (
    <div className="flex flex-col gap-10">
      {detail.active_operations.length ? (
        <div className="flex flex-col gap-2">
          {detail.active_operations.map((op) => (
            <OperationStatus key={op.id} opId={op.id} label="Job analysis" onDone={() => reload()} />
          ))}
        </div>
      ) : null}

      {!a ? (
        <EmptyState title="No analysis yet" icon={<AlertTriangle className="size-4" />}>
          {detail.active_operations.length ? "Analysis is running; results will appear here when it finishes." :
            "This job has captured text but no analysis. Use Re-analyze to run it."}
        </EmptyState>
      ) : (
        <>
          {!a.is_latest ? (
            <Notice tone="info" title="You are viewing an older analysis">
              <Button size="sm" variant="link" onClick={() => setAnalysisId(null)}>Show the latest analysis</Button>
            </Notice>
          ) : null}
          {a.stale ? (
            <Notice tone="warn" title="This analysis is for an older snapshot">
              The job text has been captured again since. Re-analyze to analyse the newest text.
            </Notice>
          ) : null}
          {a.status === "partial" ? (
            <Notice tone="warn" title="Partial analysis">
              The model step did not complete, so some details below come from a keyword scan only. See issues.
            </Notice>
          ) : null}
          {!a.result.language.supported ? (
            <Notice tone="warn" title="Language not supported">{a.result.language.reason || "Prepzy supports English postings only."}</Notice>
          ) : null}

          <section aria-labelledby="fields-h">
            <SectionTitle id="fields-h">Posting details</SectionTitle>
            <ul className="divide-y divide-line border-y border-line">
              {Object.keys(FIELD_LABELS).filter((key) => showEmpty || a.result.fields[key]?.value).map((key) => {
                const f = a.result.fields[key];
                if (!f) return null;
                return (
                  <li key={key} className="py-3 grid gap-1 sm:grid-cols-[180px_1fr_auto] sm:items-start">
                    <span className="text-sm text-muted">{FIELD_LABELS[key]}</span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {f.value ? <span className="text-sm text-ink break-words">{f.value}</span> : <span className="text-sm text-muted italic">Not stated</span>}
                        {f.value || f.source !== "unknown" ? <SourceBadge source={f.source} /> : null}
                        {f.kind === "as_written" ? <Badge>As written</Badge> : null}
                      </div>
                      {f.note ? <p className="text-[13px] text-muted mt-0.5">{f.note}</p> : null}
                      {f.conflict ? <p className="text-[13px] text-warn mt-0.5">Page metadata says: {f.conflict.structured_data}</p> : null}
                      {f.original ? (
                        <p className="text-[13px] text-muted mt-0.5">Originally: {f.original.value ?? "Not stated"} ({humanize(f.original.source)})</p>
                      ) : null}
                      {f.evidence?.quote ? <EvidenceToggle quote={f.evidence.quote} /> : null}
                    </div>
                    <div className="flex gap-1 sm:justify-end">
                      {a.is_latest ? (
                        <Button size="sm" variant="ghost" aria-label={`Correct ${FIELD_LABELS[key]}`}
                          onClick={() => { setEditing({ key, field: f }); setValue(f.value || ""); setNote(""); setError(null); }}>
                          <Pencil aria-hidden className="size-3.5" />Correct
                        </Button>
                      ) : null}
                      {f.correction_id ? (
                        <Button size="sm" variant="ghost" onClick={() => revert(key, f.correction_id!)} aria-label={`Revert ${FIELD_LABELS[key]}`}>
                          <Undo2 aria-hidden className="size-3.5" />Revert
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
            {Object.keys(FIELD_LABELS).some((k) => a.result.fields[k] && !a.result.fields[k]!.value) ? (
              <button type="button" onClick={() => setShowEmpty((v) => !v)} className="mt-2 text-[13px] text-accent hover:underline underline-offset-4">
                {showEmpty ? "Hide fields the posting doesn't state" : `Show fields the posting doesn't state (${Object.keys(FIELD_LABELS).filter((k) => a.result.fields[k] && !a.result.fields[k]!.value).length})`}
              </button>
            ) : null}
          </section>

          {a.result.responsibilities.length ? (
            <section aria-labelledby="resp-h">
              <SectionTitle id="resp-h">Responsibilities (quoted)</SectionTitle>
              <ul className="list-disc pl-5 text-sm text-ink-2 flex flex-col gap-1">
                {a.result.responsibilities.map((r, i) => <li key={i} className="break-words">{r.text}</li>)}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="domains-h" className="grid gap-8 sm:grid-cols-2">
            <div>
              <SectionTitle id="domains-h">Domains</SectionTitle>
              {a.result.domains.length ? (
                <div className="flex flex-wrap gap-1.5">{a.result.domains.map((d) => <Badge key={d.id}>{d.label}</Badge>)}</div>
              ) : <p className="text-sm text-muted">No domain identified.</p>}
            </div>
            <div>
              <SectionTitle>Skills mentioned</SectionTitle>
              {a.result.skills_mentioned.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {a.result.skills_mentioned.map((s) => <Badge key={s.id}>{s.label} <span className="text-muted">×{s.count}</span></Badge>)}
                </div>
              ) : <p className="text-sm text-muted">No taxonomy skills found in the text.</p>}
            </div>
          </section>

          {a.issues.length ? (
          <section aria-labelledby="issues-h">
            <SectionTitle id="issues-h">Things to double-check ({a.issues.length})</SectionTitle>
            {a.issues.length ? (
              <ul className="flex flex-col gap-2">
                {a.issues.map((i, n) => (
                  <li key={n} className="flex items-start gap-2 text-sm">
                    <AlertTriangle aria-hidden className="size-4 text-warn mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      <span className="text-ink-2 break-words">{i.message}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
          ) : null}

          <details className="group rounded-xl bg-surface-2 px-4 py-3">
            <summary className="cursor-pointer list-none text-sm font-medium text-ink-2">Technical details</summary>
            <DefinitionList items={[
              { term: "Status", desc: humanize(a.status) },
              { term: "Created", desc: formatDateTime(a.created_at) },
              { term: "Model", desc: a.model === "none" ? "None (keyword scan only)" : a.model },
              { term: "Prompt version", desc: <span className="font-mono text-[13px]">{a.prompt_version}</span> },
              { term: "Schema version", desc: <span className="font-mono text-[13px]">{a.schema_version}</span> },
              { term: "Taxonomy version", desc: <span className="font-mono text-[13px]">{a.taxonomy_version}</span> },
              { term: "Duration", desc: a.duration_ms ? `${(a.duration_ms / 1000).toFixed(1)} s` : "—" },
              { term: "Current", desc: a.stale ? "Stale (older snapshot)" : "Matches newest snapshot" },
            ]} />
            {detail.history.length > 1 ? (
              <div className="mt-4 max-w-md">
                <Field label="Analysis history" hint="Older analyses are kept. Corrections apply to the analysis they were made on.">
                  {(p) => (
                    <Select id={p.id} value={analysisId || a.id} aria-describedby={p.describedBy}
                      onChange={(e) => setAnalysisId(e.target.value === detail.history[0].id ? null : e.target.value)}>
                      {detail.history.map((h, i) => (
                        <option key={h.id} value={h.id}>{formatDateTime(h.created_at)} · {humanize(h.status)}{i === 0 ? " (latest)" : ""}</option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
            ) : null}
          </details>
        </>
      )}

      <section aria-labelledby="avail-h" className="max-w-md">
        <SectionTitle id="avail-h">Availability</SectionTitle>
        <Field label="Is this posting still open?" hint="Prepzy cannot check this; it records what you observed.">
          {(p) => (
            <Select id={p.id} value={detail.job.availability} onChange={(e) => setAvailability(e.target.value)} aria-describedby={p.describedBy}>
              <option value="unknown">Unknown</option>
              <option value="last_observed">Open when I last looked</option>
              <option value="closed">Closed</option>
            </Select>
          )}
        </Field>
        {detail.job.last_observed_at ? <p className="text-[13px] text-muted mt-1">Last observed {formatDateTime(detail.job.last_observed_at)}</p> : null}
      </section>

      <Dialog open={Boolean(editing)} onClose={() => setEditing(null)}
        title={`Correct ${editing ? FIELD_LABELS[editing.key] || editing.key : ""}`}
        description="Your correction is stored separately; the original analysis stays visible and can be restored."
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={saveField}>Save correction</Button></>}>
        {editing ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-ink-2">Analysed value: {editing.field.original?.value ?? editing.field.value ?? "Not stated"}</p>
            <Field label="Correct value" hint="Leave empty to mark it as not stated.">
              {(p) => <Input id={p.id} value={value} maxLength={300} onChange={(e) => setValue(e.target.value)} data-autofocus aria-describedby={p.describedBy} />}
            </Field>
            <Field label="Note (optional)">
              {(p) => <Textarea id={p.id} rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            {error ? <ErrorState error={error} title="Could not save the correction" /> : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
