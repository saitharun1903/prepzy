"use client";

import Link from "next/link";
import { ArrowRight, Bell, Briefcase, CalendarCheck, CalendarClock, Check, FileText, MessagesSquare, Route, UserRound } from "lucide-react";
import { useApi } from "@/lib/hooks";
import { formatDateTime, humanize, jobTitle, relativeTime } from "@/lib/format";
import type { InterviewSessionSummary, JobSummary, Profile, Reminder, Resume, RoadmapSummary } from "@/lib/types";
import { useSession } from "@/components/shell/session";
import { Badge, ButtonLink, EmptyState, ErrorState, LoadingBlock, PageHeader, SectionTitle, cx } from "@/components/ui/primitives";

type Action = { key: string; href: string; title: string; detail: string; icon: typeof Briefcase };
type Step = { key: string; title: string; detail: string; href: string; cta: string; done: boolean; icon: typeof Briefcase };

/** The five-step journey, in order. The first unfinished step is the one thing to do next. */
function Journey({ steps, loading }: { steps: Step[]; loading: boolean }) {
  const doneCount = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  const pct = Math.round((100 * doneCount) / steps.length);
  return (
    <section aria-labelledby="journey-h" className="mb-12 rounded-2xl border border-line bg-surface surface-premium p-5 sm:p-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="journey-h" className="serif text-xl">Your path to the next job</h2>
          <p className="text-sm text-ink-2 mt-1">{next ? "Five short steps. Do them in order; each one uses the last." : "All five steps done. Repeat steps 2–5 for every job you're interested in."}</p>
        </div>
        <p className="text-sm text-muted"><span className="num text-ink font-semibold">{doneCount}</span> of {steps.length} done</p>
      </div>
      <div className="mt-4 h-2 rounded-full bg-surface-2 overflow-hidden" role="progressbar" aria-label="Steps completed" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount}>
        <div className="h-full rounded-full bar-brand transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
      <ol className="mt-6 grid gap-2">
        {steps.map((st, i) => {
          const current = !loading && next?.key === st.key;
          const Icon = st.icon;
          return (
            <li key={st.key}>
              <Link href={st.href} aria-current={current ? "step" : undefined}
                className={cx("group flex items-center gap-4 rounded-xl border p-3.5 sm:p-4 transition-colors",
                  current ? "border-gold/60 bg-gradient-to-r from-gold-soft to-white shadow-[0_10px_28px_-14px_rgba(15,29,51,0.45)]" : "border-line bg-white lift hover:border-accent/30")}>
                <span aria-hidden className={cx("grid place-items-center size-9 shrink-0 rounded-full text-sm font-semibold",
                  st.done ? "bg-gradient-to-br from-emerald-500 to-emerald-700 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_4px_10px_-4px_rgba(4,120,87,0.6)]" : current ? "icon-chip-solid" : "bg-white text-muted border border-line shadow-[inset_0_1px_0_#fff]")}>
                  {st.done ? <Check className="size-4" /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 font-medium text-ink">
                    <Icon aria-hidden className="size-4 text-muted hidden sm:block" />{st.title}
                    {st.done ? <span className="sr-only">(done)</span> : null}
                  </span>
                  <span className="block text-sm text-ink-2 mt-0.5">{st.detail}</span>
                </span>
                {current ? (
                  <span className="btn-gloss hidden sm:inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 h-9 text-sm font-medium text-accent-ink">
                    {st.cta}<ArrowRight aria-hidden className="size-4" />
                  </span>
                ) : (
                  <ArrowRight aria-hidden className="size-4 text-muted group-hover:text-ink" />
                )}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default function HomePage() {
  const { me, unread } = useSession();
  const profile = useApi<Profile>("profile");
  const resumes = useApi<Resume[]>("resumes");
  const jobs = useApi<{ items: JobSummary[]; total: number }>("jobs", { limit: 6 });
  const reminders = useApi<Reminder[]>("reminders", { status: "scheduled", limit: 5 });
  const roadmaps = useApi<RoadmapSummary[]>("roadmaps");
  const sessions = useApi<InterviewSessionSummary[]>("interviews");

  const loading = profile.loading || resumes.loading || jobs.loading || reminders.loading || roadmaps.loading || sessions.loading;
  const anyError = profile.error || resumes.error || jobs.error || reminders.error || roadmaps.error;

  const actions: Action[] = [];
  if (profile.data && !profile.data.onboarded_at) {
    actions.push({ key: "onboard", href: "/onboarding", title: "Finish setting up", detail: "Add target roles, domains and weekly study time.", icon: UserRound });
  }
  const parsedVersions = (resumes.data || []).flatMap((r) => r.versions).filter((v) => v.parse_status === "parsed");
  if (resumes.data && resumes.data.length > 0 && parsedVersions.length === 0) {
    actions.push({ key: "resume-parse", href: "/resumes", title: "Fix your resume upload", detail: "None of your resume versions could be read yet.", icon: FileText });
  }
  for (const j of (jobs.data?.items || []).filter((j) => !j.latest_analysis_status).slice(0, 3)) {
    actions.push({ key: `analyze-${j.id}`, href: `/jobs/${j.id}`, title: `Analysis missing: ${jobTitle(j)}`, detail: "This job has no completed analysis. Open it to re-run.", icon: Briefcase });
  }
  if (unread > 0) {
    actions.push({ key: "notif", href: "/notifications", title: `${unread} unread notification${unread === 1 ? "" : "s"}`, detail: "Reminders and updates waiting for you.", icon: Bell });
  }
  const activePlans = (roadmaps.data || []).filter((r) => r.status === "active");

  const name = me?.user.display_name;
  const analyzed = (jobs.data?.items || []).find((j) => j.latest_analysis_status);
  const steps: Step[] = [
    { key: "resume", icon: FileText, title: "Add your resume", cta: "Add resume", href: "/resumes",
      detail: "Upload a PDF or Word file, or paste the text. It is the evidence every job is compared with.",
      done: parsedVersions.length > 0 },
    { key: "job", icon: Briefcase, title: "Analyze a job and see your match", cta: analyzed ? "See match" : "Analyze a job",
      href: analyzed ? `/jobs/${analyzed.id}?tab=match` : "/jobs/new",
      detail: "Paste a posting (or use the browser extension). See which requirements you already cover and what is missing.",
      done: Boolean(analyzed) },
    { key: "plan", icon: Route, title: "Make a study plan for the gaps", cta: "Create plan", href: "/preparation",
      detail: "A week-by-week plan that fits the hours you have.", done: (roadmaps.data || []).length > 0 },
    { key: "practice", icon: MessagesSquare, title: "Practise interview questions", cta: "Start practising",
      href: analyzed ? `/interviews/new?job_id=${analyzed.id}` : "/interviews/new",
      detail: "Questions built from the job's requirements, with feedback on each answer.",
      done: (sessions.data || []).some((x) => x.answered > 0) },
    { key: "apply", icon: CalendarCheck, title: "Track your application", cta: "Track it",
      href: analyzed ? `/jobs/${analyzed.id}?tab=application` : "/applications",
      detail: "Record when you apply, add notes and set reminders so nothing slips.",
      done: (jobs.data?.items || []).some((j) => j.application_status) },
  ];

  return (
    <>
      <PageHeader title={name ? `Hello, ${name}` : "Home"} description="Follow the steps below. Elevate shows you exactly where you stand for each job and helps you close the gaps." />
      {anyError ? <div className="mb-6"><ErrorState error={anyError} title="Some information could not be loaded" /></div> : null}

      <Journey steps={steps} loading={loading} />

      {actions.length ? (
      <section aria-labelledby="next-actions" className="mb-12">
        <SectionTitle id="next-actions">Needs your attention</SectionTitle>
        {actions.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {actions.map((a) => {
              const Icon = a.icon;
              return (
                <li key={a.key}>
                  <Link href={a.href} className="group flex h-full items-start gap-3 rounded-xl border border-line bg-surface surface-premium lift p-4">
                    <span aria-hidden className="icon-chip size-9 shrink-0"><Icon className="size-[18px]" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-ink break-words">{a.title}</span>
                      <span className="block text-sm text-ink-2 mt-0.5">{a.detail}</span>
                    </span>
                    <ArrowRight aria-hidden className="size-4 text-muted group-hover:text-ink mt-1" />
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
      ) : null}

      <div className="grid gap-12 lg:grid-cols-2">
        <section aria-labelledby="upcoming">
          <SectionTitle id="upcoming" actions={<ButtonLink href="/applications" size="sm" variant="ghost">Applications</ButtonLink>}>Upcoming reminders</SectionTitle>
          {reminders.data && !reminders.data.length ? <p className="text-sm text-muted">No scheduled reminders.</p> : null}
          {reminders.data?.length ? (
            <ul className="divide-y divide-line border-y border-line">
              {reminders.data.map((r) => (
                <li key={r.id} className="py-3 flex items-start gap-3">
                  <CalendarClock aria-hidden className="size-4 text-muted mt-1 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium break-words">{r.title}</p>
                    <p className="text-[13px] text-muted">{formatDateTime(r.due_at)} · {relativeTime(r.due_at)}</p>
                    {r.job_id ? <Link href={`/jobs/${r.job_id}?tab=application`} className="text-[13px] text-accent underline underline-offset-4">Open job</Link> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section aria-labelledby="plans">
          <SectionTitle id="plans" actions={<ButtonLink href="/preparation" size="sm" variant="ghost">All plans</ButtonLink>}>Active preparation</SectionTitle>
          {roadmaps.data && !activePlans.length ? <p className="text-sm text-muted">No active plans.</p> : null}
          {activePlans.length ? (
            <ul className="divide-y divide-line border-y border-line">
              {activePlans.slice(0, 4).map((r) => {
                const pct = r.progress.total ? Math.round((100 * r.progress.done) / r.progress.total) : 0;
                return (
                  <li key={r.id} className="py-3">
                    <Link href={`/preparation/${r.id}`} className="text-sm font-medium hover:underline underline-offset-4 break-words">{r.title}</Link>
                    <div className="mt-2 flex items-center gap-3">
                      <div className="h-1.5 flex-1 rounded-full bg-surface-2 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={r.progress.total} aria-valuenow={r.progress.done} aria-label={`${r.title} tasks done`}>
                        <div className="h-full bar-brand" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[13px] text-muted whitespace-nowrap">{r.progress.done} of {r.progress.total} tasks</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      </div>

      <section aria-labelledby="recent-jobs" className="mt-12">
        <SectionTitle id="recent-jobs" actions={<ButtonLink href="/jobs/new" size="sm" variant="primary">Analyze a job</ButtonLink>}>Recent jobs</SectionTitle>
        {jobs.loading && !jobs.data ? <LoadingBlock rows={2} /> : null}
        {jobs.data && !jobs.data.items.length ? (
          <EmptyState title="No jobs yet" action={<ButtonLink href="/jobs/new" variant="primary">Analyze a job</ButtonLink>}>
            Paste a job posting, or use the browser extension on a job page.
          </EmptyState>
        ) : null}
        {jobs.data?.items.length ? (
          <ul className="divide-y divide-line border-y border-line">
            {jobs.data.items.map((j) => (
              <li key={j.id} className="py-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link href={`/jobs/${j.id}`} className="font-medium hover:underline underline-offset-4 min-w-0 break-words">{jobTitle(j)}</Link>
                {j.company ? <span className="text-sm text-ink-2">{j.company}</span> : null}
                <span className="ml-auto flex items-center gap-2">
                  {j.application_status ? <Badge tone="accent">{humanize(j.application_status)}</Badge> : null}
                  <span className="text-[13px] text-muted">{relativeTime(j.updated_at)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}
