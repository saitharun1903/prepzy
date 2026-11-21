"use client";

import { useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Lightbulb, Quote } from "lucide-react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { humanize } from "@/lib/format";
import type { Accepted, QAResult } from "@/lib/types";
import { OperationStatus } from "@/components/operation-status";
import { Badge, Button, ErrorState, Field, Textarea } from "@/components/ui/primitives";

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
        <Field label="Ask anything about this job" hint="Answers quote the posting where it says something, then give advice for your match.">
          {(p) => <Textarea id={p.id} rows={3} maxLength={1000} value={question} onChange={(e) => setQuestion(e.target.value)} aria-describedby={p.describedBy} placeholder="e.g. How should I prepare for this role in two weeks?" />}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={question.trim().length < 3}>Ask</Button>
          {["Am I a good fit for this role?", "What should I learn first?", "Is this role remote or on-site?"].map((q) => (
            <button key={q} type="button" onClick={() => setQuestion(q)}
              className="h-10 rounded-full border border-line bg-white px-3.5 text-[13px] text-ink-2 hover:border-gold hover:text-ink">{q}</button>
          ))}
        </div>
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
    <div className="mt-3 grid gap-3">
      <section className="rounded-xl border border-line bg-surface surface-premium p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-ink"><span aria-hidden className="icon-chip size-7"><Quote className="size-3.5" /></span>From the job posting</h3>
          {r.sufficient_evidence ? (
            <span className="inline-flex items-center gap-1.5 text-[13px] text-ok font-medium"><CheckCircle2 aria-hidden className="size-4" />Quoted and verified</span>
          ) : (
            <Badge tone="warn">Not stated in the posting</Badge>
          )}
        </div>
        <p className="text-[15px] text-ink prewrap">{r.answer}</p>
        {!r.sufficient_evidence && r.note ? <p className="mt-2 text-[13px] text-muted">{r.note}</p> : null}
        {r.citations.length ? (
          <ol className="mt-3 flex flex-col gap-2 list-decimal pl-5">
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
                <blockquote className="mt-1 border-l-2 border-gold pl-2 text-ink-2 break-words">{c.excerpt}</blockquote>
              </li>
            ))}
          </ol>
        ) : null}
      </section>
      {r.guidance ? (
        <section className="rounded-xl border border-gold/40 bg-gradient-to-br from-gold-soft/70 to-white p-4 sm:p-5">
          <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-ink mb-2"><span aria-hidden className="icon-chip size-7"><Lightbulb className="size-3.5" /></span>Guidance for you</h3>
          <p className="text-[15px] text-ink prewrap">{r.guidance}</p>
          <p className="mt-2 text-[12px] text-muted">General advice based on your match, not a statement about this company.</p>
        </section>
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
