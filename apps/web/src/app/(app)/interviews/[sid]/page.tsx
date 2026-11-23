"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, CircleHelp, CircleMinus, Timer, XCircle } from "lucide-react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { useApi, useSessionDraft } from "@/lib/hooks";
import { formatDateTime, humanize } from "@/lib/format";
import type { Accepted, Evaluation, InterviewAnswer, InterviewQuestion, InterviewSession } from "@/lib/types";
import { OperationStatus } from "@/components/operation-status";
import {
  Badge, Button, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader, SectionTitle, Textarea, cx,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { MODEL } from "@/lib/hosting";

const RATING = {
  met: { label: "Met", icon: CheckCircle2, tone: "text-ok" },
  partly: { label: "Partly met", icon: CircleMinus, tone: "text-warn" },
  not_met: { label: "Not met", icon: XCircle, tone: "text-danger" },
  cannot_assess: { label: "Cannot assess", icon: CircleHelp, tone: "text-muted" },
} as const;

function SessionTimer({ sid, minutes }: { sid: string; minutes: number }) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const k = `elevate.timer.${sid}`;
    let start = Date.now();
    try {
      const s = sessionStorage.getItem(k);
      if (s) start = Number(s);
      else sessionStorage.setItem(k, String(start));
    } catch { /* storage unavailable */ }
    const tick = () => setLeft(Math.max(0, minutes * 60 - Math.floor((Date.now() - start) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [sid, minutes]);
  if (left === null) return null;
  const m = Math.floor(left / 60);
  const s = left % 60;
  return (
    <div className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm">
      <Timer aria-hidden className="size-4 text-muted" />
      <span className="font-mono tabular-nums" aria-hidden>{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}</span>
      <span className="sr-only">{left === 0 ? "Time is up" : `${m} minutes ${s} seconds left`}</span>
      <span className="text-[12px] text-muted">{left === 0 ? "Time is up — browser timer only, nothing is enforced" : "Browser-only timer, not enforced"}</span>
    </div>
  );
}

function EvaluationView({ ev }: { ev: Evaluation }) {
  if (!ev.assessable) {
    // Nothing could be rated (off-topic or too thin): coach instead of listing six "cannot assess" rows.
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="warn" title="This answer doesn't address the question yet">
          {ev.reason || "There wasn't enough about this question to give feedback."} Try again and cover these points:
          <ul className="mt-2 list-disc pl-5 flex flex-col gap-1">{ev.criteria.map((c, i) => <li key={i}>{c.criterion}</li>)}</ul>
        </Notice>
        <p className="text-[12px] text-muted">Tip: open with a one-line definition, then give a concrete example from your own work, then a trade-off.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y divide-line border-y border-line">
        {ev.criteria.map((c, i) => {
          const r = RATING[c.rating] || RATING.cannot_assess;
          const Icon = r.icon;
          return (
            <li key={i} className="py-3 grid gap-1 sm:grid-cols-[160px_1fr]">
              <span className={cx("inline-flex items-center gap-1.5 text-sm font-medium", r.tone)}><Icon aria-hidden className="size-4" />{r.label}</span>
              <div className="min-w-0">
                <p className="text-sm text-ink">{c.criterion}</p>
                {c.answer_quote ? <blockquote className="mt-1 border-l-2 border-line-strong pl-2 text-[13px] text-ink-2 break-words">&ldquo;{c.answer_quote}&rdquo;</blockquote> : null}
                {c.comment && !/^not evaluated by the model\.?$/i.test(c.comment) ? <p className="mt-1 text-[13px] text-muted">{c.comment}</p> : null}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="grid gap-6 sm:grid-cols-3">
        {([["Strengths", ev.strengths], ["Gaps", ev.gaps], ["How to improve", ev.improvements]] as const).map(([t, xs]) => (
          <div key={t}>
            <p className="text-sm font-medium mb-1">{t}</p>
            {xs.length ? <ul className="list-disc pl-5 text-sm text-ink-2 flex flex-col gap-1">{xs.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="text-sm text-muted">None noted.</p>}
          </div>
        ))}
      </div>
      <p className="text-[12px] text-muted">Feedback {ev.method === "rule" ? "from a rule (answer too short)" : ev.method === "checklist" ? "from the built-in checklist (AI unavailable): it checks your answer's structure, not whether it is correct" : `from ${MODEL}${ev.model ? ` (${ev.model})` : ""}`}. It is practice feedback, not a hiring judgement.</p>
    </div>
  );
}

function QuestionView({ sid, q, active, onChanged }: { sid: string; q: InterviewQuestion; active: boolean; onChanged: () => void }) {
  const { notify } = useToast();
  const latest: InterviewAnswer | undefined = q.answers[q.answers.length - 1];
  const [draft, setDraft, clearDraft] = useSessionDraft(`elevate.answer.${q.id}`);
  const [composing, setComposing] = useState(!latest);
  const [viewRev, setViewRev] = useState<number | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const started = useRef<string>(new Date().toISOString());

  useEffect(() => {
    setComposing(!q.answers.length);
    setViewRev(null);
    started.current = new Date().toISOString();
  }, [q.id, q.answers.length]);

  const shown = viewRev !== null ? q.answers.find((a) => a.revision === viewRev) : latest;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<Accepted & { revision: number }>(`interviews/${sid}/questions/${q.id}/answers`, {
        method: "POST", idempotencyKey: newIdempotencyKey(), body: { answer: draft, started_at: started.current },
      });
      setOpId(r.operation_id);
      clearDraft();
      setComposing(false);
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    try {
      await apiFetch(`interviews/${sid}/questions/${q.id}/skip`, { method: "POST" });
      notify("ok", "Question skipped");
      onChanged();
    } catch (e) {
      notify("error", (e as ApiError).message);
    }
  };

  const codeKind = q.kind === "coding" || q.kind === "sql";
  return (
    <article aria-labelledby={`q-${q.id}`} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{q.kind_label}</Badge>
        <Badge>{q.origin === "template" ? "Built-in practice question" : "Generated practice question"}</Badge>
        {q.topic ? <Badge>{q.topic}</Badge> : null}
        {q.status === "skipped" ? <Badge tone="warn">Skipped</Badge> : null}
      </div>
      <h2 id={`q-${q.id}`} className="serif text-2xl leading-snug prewrap">{q.prompt}</h2>
      {codeKind ? <Notice tone="info">Write code or pseudocode as text. It is read and assessed against the rubric but never executed.</Notice> : null}
      <details className="text-sm">
        <summary className="cursor-pointer text-ink-2">What the feedback looks at ({q.rubric.length} criteria)</summary>
        <ul className="mt-2 list-disc pl-5 text-ink-2 flex flex-col gap-0.5">
          {q.rubric.map((r, i) => <li key={i}>{r.criterion}{r.origin === "generated" ? <span className="text-muted"> (role-specific, generated)</span> : null}</li>)}
        </ul>
      </details>

      {composing ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={`ans-${q.id}`} className="text-sm font-medium">{latest ? `New attempt (revision ${latest.revision + 1})` : "Your answer"}</label>
          <Textarea id={`ans-${q.id}`} rows={10} maxLength={12000} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!active}
            className={codeKind ? "font-mono text-[13px]" : ""} />
          {!active ? <p className="text-[13px] text-muted">Resume the session to answer.</p> : null}
          {error ? <ErrorState error={error} title="Could not submit" /> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={busy} disabled={!draft.trim() || !active} onClick={submit}>Submit for feedback</Button>
            {latest ? <Button variant="ghost" onClick={() => setComposing(false)}>Cancel</Button> : null}
            {q.status === "pending" ? <Button variant="ghost" onClick={skip} disabled={!active}>Skip question</Button> : null}
          </div>
        </div>
      ) : null}

      {opId ? <OperationStatus opId={opId} label="Evaluating your answer" onDone={() => { setOpId(null); onChanged(); }} /> : null}

      {shown && !composing ? (
        <section aria-labelledby={`fb-${q.id}`} className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <SectionTitle id={`fb-${q.id}`}>Your answer · revision {shown.revision}</SectionTitle>
            {q.answers.length > 1 ? (
              <div className="flex flex-wrap gap-1 ml-auto" role="group" aria-label="Revisions">
                {q.answers.map((a) => (
                  <button key={a.id} type="button" aria-pressed={shown.revision === a.revision} onClick={() => setViewRev(a.revision)}
                    className={cx("h-7 px-2.5 rounded text-[13px] border", shown.revision === a.revision ? "border-accent bg-accent-soft" : "border-line text-muted")}>
                    Rev {a.revision}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="rounded-md border border-line bg-surface p-3">
            <p className={cx("text-sm prewrap", codeKind && "font-mono text-[13px]")}>{shown.answer}</p>
            <p className="mt-2 text-[12px] text-muted">Submitted {formatDateTime(shown.submitted_at)}</p>
          </div>
          {shown.evaluation ? <EvaluationView ev={shown.evaluation} /> : shown.eval_status === "failed" ? (
            <Notice tone="danger" title="Evaluation failed">The model could not evaluate this answer. Submit a new attempt to try again.</Notice>
          ) : !opId ? (
            <Notice tone="info" title="Evaluation pending">
              Feedback has not been recorded yet. <Button size="sm" variant="link" onClick={onChanged}>Check again</Button>
            </Notice>
          ) : null}
          {active ? (
            <div><Button onClick={() => { setDraft(draft || shown.answer); setComposing(true); }}>Try again (new revision)</Button></div>
          ) : null}
        </section>
      ) : null}
    </article>
  );
}

export default function InterviewSessionPage({ params }: { params: Promise<{ sid: string }> }) {
  const { sid } = use(params);
  const { notify } = useToast();
  const s = useApi<InterviewSession>(`interviews/${sid}`);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const initialised = useRef(false);

  const questions = useMemo(() => s.data?.questions || [], [s.data]);
  useEffect(() => {
    if (initialised.current || !questions.length) return;
    initialised.current = true;
    const firstOpen = questions.findIndex((q) => q.status === "pending");
    setIdx(firstOpen >= 0 ? firstOpen : 0);
  }, [questions]);

  const setStatus = async (action: "pause" | "resume" | "complete") => {
    setBusy(action);
    try {
      await apiFetch(`interviews/${sid}/status`, { method: "POST", body: { action } });
      notify("ok", action === "complete" ? "Session completed" : action === "pause" ? "Session paused" : "Session resumed");
      s.reload();
    } catch (e) {
      notify("error", (e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  if (s.loading && !s.data) return <LoadingBlock rows={4} label="Loading session" />;
  if (s.error && !s.data) return <ErrorState error={s.error} onRetry={s.reload} title="Could not load this session" />;
  const d = s.data;
  if (!d) return null;
  const q = questions[idx];
  const active = d.status === "active";
  const answered = questions.filter((x) => x.status === "answered").length;

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/interviews" className="hover:underline underline-offset-4">Interview practice</Link>}
        title={d.title}
        description={
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={d.status === "failed" ? "danger" : d.status === "completed" ? "ok" : "neutral"}>{humanize(d.status)}</Badge>
            <span className="text-ink-2">{humanize(d.config.difficulty)} · {answered} of {questions.length} answered</span>
            {d.job_id ? <Link href={`/jobs/${d.job_id}`} className="text-accent underline underline-offset-4">Open job</Link> : null}
          </div>
        }
        actions={
          <>
            {d.status === "active" ? <Button size="sm" loading={busy === "pause"} onClick={() => setStatus("pause")}>Pause</Button> : null}
            {d.status === "paused" || d.status === "completed" ? <Button size="sm" loading={busy === "resume"} onClick={() => setStatus("resume")}>Resume</Button> : null}
            {d.status === "active" || d.status === "paused" ? <Button size="sm" variant="primary" loading={busy === "complete"} onClick={() => setStatus("complete")}>Complete session</Button> : null}
          </>
        }
      />

      {d.status === "preparing" && d.config.operation_id ? (
        <OperationStatus opId={d.config.operation_id} label="Generating questions" onDone={() => s.reload()} />
      ) : null}
      {d.status === "preparing" && !d.config.operation_id ? <Notice tone="info">Questions are being prepared.</Notice> : null}
      {d.status === "failed" ? (
        <div className="flex flex-col gap-3">
          <Notice tone="danger" title="Question generation failed">{MODEL === "the AI model" ? "The AI model" : "The local model"} could not produce questions for this session.</Notice>
          {d.config.operation_id ? <OperationStatus opId={d.config.operation_id} label="Question generation" onDone={() => s.reload()} /> : null}
        </div>
      ) : null}

      {d.config.mode === "timed" && d.config.minutes && (d.status === "active" || d.status === "paused") ? (
        <div className="mb-6"><SessionTimer sid={sid} minutes={d.config.minutes} /></div>
      ) : null}

      {questions.length ? (
        <div className="flex flex-col gap-6">
          <nav aria-label="Questions" className="flex flex-wrap items-center gap-1.5">
            {questions.map((x, i) => (
              <button key={x.id} type="button" onClick={() => setIdx(i)} aria-current={i === idx ? "step" : undefined}
                aria-label={`Question ${i + 1}, ${x.status}`}
                className={cx("size-9 rounded-md border text-sm tabular-nums inline-flex items-center justify-center",
                  i === idx ? "border-accent bg-accent-soft text-ink font-medium" : "border-line text-ink-2 hover:bg-surface-2",
                  x.status === "answered" && i !== idx && "bg-surface-2")}>
                {x.status === "answered" ? <CheckCircle2 aria-hidden className="size-4 text-ok" /> : i + 1}
              </button>
            ))}
          </nav>
          {q ? <QuestionView key={q.id} sid={sid} q={q} active={active} onChanged={s.reload} /> : null}
          <div className="flex justify-between border-t border-line pt-4">
            <Button variant="ghost" disabled={idx === 0} onClick={() => setIdx(idx - 1)}><ChevronLeft aria-hidden className="size-4" />Previous</Button>
            <span className="self-center text-sm text-muted">Question {idx + 1} of {questions.length}</span>
            <Button variant="ghost" disabled={idx >= questions.length - 1} onClick={() => setIdx(idx + 1)}>Next<ChevronRight aria-hidden className="size-4" /></Button>
          </div>
        </div>
      ) : d.status !== "preparing" && d.status !== "failed" ? <EmptyState title="No questions in this session" /> : null}
    </>
  );
}
