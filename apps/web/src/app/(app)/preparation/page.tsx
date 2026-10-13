"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiError, apiFetch } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatDate, humanize, jobTitle, todayISO } from "@/lib/format";
import type { JobSummary, Profile, Roadmap, RoadmapSummary } from "@/lib/types";
import {
  Badge, Button, EmptyState, ErrorState, Field, Input, LoadingBlock, Notice, PageHeader, SectionTitle, Select, Skeleton,
} from "@/components/ui/primitives";

export default function PreparationPage() {
  const router = useRouter();
  const list = useApi<RoadmapSummary[]>("roadmaps");
  const jobs = useApi<{ items: JobSummary[] }>("jobs", { limit: 100 });
  const profile = useApi<Profile>("profile");
  const [jobId, setJobId] = useState("");
  const [hours, setHours] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [created, setCreated] = useState<Roadmap | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<Roadmap>("roadmaps", {
        method: "POST",
        body: { job_id: jobId || null, weekly_hours: hours ? Number(hours) : null, target_date: target || null },
      });
      list.reload();
      if (r.feasibility.feasible === false) setCreated(r);
      else router.push(`/preparation/${r.id}`);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Preparation" description="Weekly plans built from the gaps in a job comparison, or a generic starter plan for your target domains." />

      <section aria-labelledby="new-h" className="mb-12">
        <SectionTitle id="new-h">Create a plan</SectionTitle>
        <form onSubmit={create} className="rounded-lg border border-line bg-surface p-4 grid gap-4 sm:grid-cols-3 max-w-3xl" noValidate>
          <Field label="Job (optional)" className="sm:col-span-3"
            hint="With a job, the plan targets the priorities from its latest comparison. Without one, a generic starter plan is built from your profile domains.">
            {(p) => jobs.loading && !jobs.data ? <Skeleton className="h-10" /> : (
              <Select id={p.id} value={jobId} onChange={(e) => setJobId(e.target.value)} aria-describedby={p.describedBy}>
                <option value="">No job — generic starter plan</option>
                {jobs.data?.items.map((j) => <option key={j.id} value={j.id}>{jobTitle(j)}{j.company ? ` — ${j.company}` : ""}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Weekly hours" error={error?.fields?.weekly_hours}
            hint={profile.data?.weekly_hours ? `Leave empty to use your profile (${profile.data.weekly_hours} h).` : "Required unless set in your profile."}>
            {(p) => <Input id={p.id} type="number" min={1} max={60} value={hours} onChange={(e) => setHours(e.target.value)} aria-describedby={p.describedBy} aria-invalid={p.invalid} />}
          </Field>
          <Field label="Target date (optional)" error={error?.fields?.target_date}
            hint={profile.data?.target_date ? `Defaults to your profile date (${formatDate(profile.data.target_date)}).` : undefined}>
            {(p) => <Input id={p.id} type="date" min={todayISO()} value={target} onChange={(e) => setTarget(e.target.value)} aria-describedby={p.describedBy} aria-invalid={p.invalid} />}
          </Field>
          <div className="sm:col-span-3 flex flex-col gap-3">
            {error && !Object.keys(error.fields).length ? (
              <ErrorState error={error} title={error.code === "insufficient_profile" ? "Not enough to plan from" : error.code === "nothing_to_plan" ? "Nothing to plan" : "Could not create the plan"} />
            ) : null}
            {error?.code === "insufficient_profile" ? (
              <p className="text-sm"><Link href="/profile" className="text-accent underline underline-offset-4">Choose target domains in your profile</Link> or compare a job with your resume first.</p>
            ) : null}
            <div><Button type="submit" variant="primary" loading={busy}>Create plan</Button></div>
          </div>
        </form>
        {created ? (
          <Notice tone="warn" className="mt-4 max-w-3xl" title="This plan does not fit before your target date">
            <p>It needs about {created.feasibility.weeks_needed} week(s) at {created.feasibility.weekly_hours} h/week; {created.feasibility.available_weeks ?? 0} week(s) are available.</p>
            {created.feasibility.suggestions?.length ? <ul className="list-disc pl-5 mt-1">{created.feasibility.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ul> : null}
            <Button size="sm" className="mt-2" onClick={() => router.push(`/preparation/${created.id}`)}>Open the plan</Button>
          </Notice>
        ) : null}
      </section>

      <section aria-labelledby="plans-h">
        <SectionTitle id="plans-h">Your plans</SectionTitle>
        {list.loading && !list.data ? <LoadingBlock rows={2} /> : null}
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.data && !list.data.length ? <EmptyState title="No plans yet">Create one above.</EmptyState> : null}
        {list.data?.length ? (
          <ul className="divide-y divide-line border-y border-line">
            {list.data.map((r) => (
              <li key={r.id} className="py-4 flex flex-col sm:flex-row sm:items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Link href={`/preparation/${r.id}`} className="font-medium hover:underline underline-offset-4 break-words">{r.title}</Link>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {r.generic ? <Badge tone="info">Generic starter plan</Badge> : null}
                    <Badge tone={r.status === "active" ? "accent" : "neutral"}>{humanize(r.status)}</Badge>
                    {r.feasible === false ? <Badge tone="warn">Doesn&apos;t fit target date</Badge> : null}
                  </div>
                </div>
                <span className="text-sm text-muted">{r.progress.done} of {r.progress.total} tasks done</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}
