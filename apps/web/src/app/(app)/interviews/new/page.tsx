"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { jobTitle } from "@/lib/format";
import type { JobSummary } from "@/lib/types";
import {
  Button, ChipsInput, ErrorState, Field, Input, LoadingBlock, Notice, PageHeader, Select, Skeleton,
} from "@/components/ui/primitives";

type Options = { domains: string[]; kinds: { id: string; label: string }[] };

function NewSessionForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const [jobId, setJobId] = useState(sp.get("job_id") || "");
  const jobs = useApi<{ items: JobSummary[] }>("jobs", { limit: 100 });
  const opts = useApi<Options>("interviews/options", jobId ? { job_id: jobId } : undefined);
  const [kinds, setKinds] = useState<string[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState("medium");
  const [count, setCount] = useState("5");
  const [mode, setMode] = useState("practice");
  const [minutes, setMinutes] = useState("30");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const key = useRef<string | null>(null);

  useEffect(() => {
    if (opts.data) setKinds(opts.data.kinds.map((k) => k.id));
  }, [opts.data]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    key.current = key.current || newIdempotencyKey();
    try {
      const r = await apiFetch<{ session_id: string }>("interviews", {
        method: "POST", idempotencyKey: key.current,
        body: {
          job_id: jobId || null, title: title.trim() || null, kinds, topics, difficulty, count: Number(count), mode,
          minutes: mode === "timed" ? Number(minutes) : null,
        },
      });
      router.push(`/interviews/${r.session_id}`);
    } catch (err) {
      setError(err as ApiError);
      key.current = null;
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-6 max-w-2xl" noValidate>
      <Field label="Job (optional)" hint="With a job, questions focus on its requirements and your gaps from the latest comparison.">
        {(p) => jobs.loading && !jobs.data ? <Skeleton className="h-10" /> : (
          <Select id={p.id} value={jobId} onChange={(e) => setJobId(e.target.value)} aria-describedby={p.describedBy}>
            <option value="">No specific job (use my profile domains)</option>
            {jobs.data?.items.map((j) => <option key={j.id} value={j.id}>{jobTitle(j)}{j.company ? ` — ${j.company}` : ""}</option>)}
          </Select>
        )}
      </Field>

      <fieldset>
        <legend className="text-sm font-medium mb-1">Question types</legend>
        <p className="text-[13px] text-muted mb-2">Only types relevant to {jobId ? "this job's" : "your profile's"} domains are offered{opts.data?.domains.length ? "" : " (no domain known, so general types are shown)"}.</p>
        {opts.loading ? <LoadingBlock rows={1} label="Loading question types" /> : null}
        {opts.error ? <ErrorState error={opts.error} onRetry={opts.reload} /> : null}
        <div className="flex flex-wrap gap-2">
          {opts.data?.kinds.map((k) => {
            const on = kinds.includes(k.id);
            return (
              <label key={k.id} className={`inline-flex items-center gap-2 h-9 rounded-full border px-3.5 text-sm cursor-pointer ${on ? "border-accent bg-accent-soft" : "border-line-strong bg-surface"}`}>
                <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={on}
                  onChange={() => setKinds(on ? kinds.filter((x) => x !== k.id) : [...kinds, k.id])} />
                {k.label}
              </label>
            );
          })}
        </div>
      </fieldset>

      <ChipsInput label="Topics (optional)" values={topics} onChange={setTopics} placeholder="e.g. window functions" hint="Focus areas for generated questions." />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Difficulty">
          {(p) => <Select id={p.id} value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
            <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
          </Select>}
        </Field>
        <Field label="Number of questions">
          {(p) => <Select id={p.id} value={count} onChange={(e) => setCount(e.target.value)}>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>}
        </Field>
        <Field label="Mode" hint="Timed mode shows a countdown in your browser only; nothing is enforced.">
          {(p) => <Select id={p.id} value={mode} onChange={(e) => setMode(e.target.value)} aria-describedby={p.describedBy}>
            <option value="practice">Practice (untimed)</option><option value="timed">Timed</option>
          </Select>}
        </Field>
        {mode === "timed" ? (
          <Field label="Minutes for the session" hint="5–180">
            {(p) => <Input id={p.id} type="number" min={5} max={180} value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-describedby={p.describedBy} />}
          </Field>
        ) : null}
        <Field label="Session title (optional)" className="sm:col-span-2">
          {(p) => <Input id={p.id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
      </div>

      <Notice tone="info">Questions are generated by the local model for practice. They are not questions any company has asked.</Notice>
      {error ? <ErrorState error={error} title="Could not create the session" /> : null}
      <div><Button type="submit" variant="primary" loading={busy} disabled={!kinds.length || opts.loading}>Generate questions</Button></div>
    </form>
  );
}

export default function NewInterviewPage() {
  return (
    <>
      <PageHeader eyebrow="Interview practice" title="New practice session" />
      <Suspense fallback={<LoadingBlock rows={3} />}>
        <NewSessionForm />
      </Suspense>
    </>
  );
}
