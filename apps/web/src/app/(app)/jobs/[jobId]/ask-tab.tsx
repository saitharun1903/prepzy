"use client";

import { useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { humanize } from "@/lib/format";
import type { Accepted, QAResult } from "@/lib/types";
import { OperationStatus } from "@/components/operation-status";
import { Badge, Button, ErrorState, Field, Notice, Textarea } from "@/components/ui/primitives";

type Entry = { id: string; question: string; opId: string; result: QAResult | null; failed?: string };

export function AskTab({ jobId }: { jobId: string }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (q.length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<Accepted>(`jobs/${jobId}/ask`, { method: "POST", body: { question: q }, idempotencyKey: newIdempotencyKey() });
      setEntries((xs) => [{ id: r.operation_id, question: q, opId: r.operation_id, result: null }, ...xs]);
      setQuestion("");
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={ask} className="flex flex-col gap-3 max-w-2xl">
        <Field label="Ask about this job" hint="Answers use only the posting text and the knowledge library, with quoted citations. If the sources don't say, the answer is marked as insufficient.">
          {(p) => <Textarea id={p.id} rows={3} maxLength={1000} value={question} onChange={(e) => setQuestion(e.target.value)} aria-describedby={p.describedBy} placeholder="e.g. Does this role require on-call work?" />}
        </Field>
        <div><Button type="submit" variant="primary" loading={busy} disabled={question.trim().length < 3}>Ask</Button></div>
        {error ? <ErrorState error={error} title="Could not ask" /> : null}
      </form>

      {entries.length ? (
        <ul className="flex flex-col gap-6">
          {entries.map((en) => (
            <li key={en.id} className="border-t border-line pt-5">
              <p className="font-medium text-ink break-words">{en.question}</p>
              {!en.result && !en.failed ? (
                <div className="mt-3">
                  <OperationStatus<QAResult> opId={en.opId} label="Answering" onDone={(op) => {
                    setEntries((xs) => xs.map((x) => x.id === en.id ? (op.result && "answer" in op.result
                      ? { ...x, result: op.result } : { ...x, failed: op.error?.message || humanize(op.state) }) : x));
                  }} />
                </div>
              ) : null}
              {en.failed ? <p className="mt-2 text-sm text-danger">No answer: {en.failed}</p> : null}
              {en.result ? <Answer r={en.result} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Answer({ r }: { r: QAResult }) {
  return (
    <div className="mt-3 flex flex-col gap-3">
      {r.sufficient_evidence ? (
        <span className="inline-flex items-center gap-1.5 text-sm text-ok font-medium"><CheckCircle2 aria-hidden className="size-4" />Supported by cited sources</span>
      ) : (
        <Notice tone="warn" title="Insufficient evidence">{r.note || "The sources do not clearly answer this. Treat the answer as unverified."}</Notice>
      )}
      <p className="text-[15px] text-ink prewrap">{r.answer}</p>
      {r.citations.length ? (
        <div>
          <p className="text-sm font-medium mb-1.5">Citations</p>
          <ol className="flex flex-col gap-2 list-decimal pl-5">
            {r.citations.map((c, i) => (
              <li key={i} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={c.source === "job_posting" ? "accent" : "info"}>{c.source === "job_posting" ? "Job posting" : c.title || "Knowledge"}</Badge>
                  {c.review_state ? <Badge>{humanize(c.review_state)}</Badge> : null}
                  {c.source_url ? (
                    <a href={c.source_url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-accent text-[13px] underline underline-offset-4">
                      Source <ExternalLink aria-hidden className="size-3" /><span className="sr-only">(opens in a new tab)</span>
                    </a>
                  ) : null}
                </div>
                <blockquote className="mt-1 border-l-2 border-line-strong pl-2 text-ink-2 break-words">{c.excerpt}</blockquote>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {r.problems.length ? (
        <ul className="text-[13px] text-muted flex flex-col gap-1">
          {r.problems.map((p, i) => <li key={i} className="flex gap-1.5"><AlertTriangle aria-hidden className="size-3.5 mt-0.5 text-warn" />{p}</li>)}
        </ul>
      ) : null}
      <p className="text-[12px] text-muted">Model: {r.model}</p>
    </div>
  );
}
