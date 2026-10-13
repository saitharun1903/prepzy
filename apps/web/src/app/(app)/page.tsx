"use client";

import Link from "next/link";
import { ArrowRight, Bell, Briefcase, CalendarClock, FileText, Route, UserRound } from "lucide-react";
import { useApi } from "@/lib/hooks";
import { formatDateTime, humanize, jobTitle, relativeTime } from "@/lib/format";
import type { JobSummary, Profile, Reminder, Resume, RoadmapSummary } from "@/lib/types";
import { useSession } from "@/components/shell/session";
import { Badge, ButtonLink, EmptyState, ErrorState, LoadingBlock, PageHeader, SectionTitle } from "@/components/ui/primitives";

type Action = { key: string; href: string; title: string; detail: string; icon: typeof Briefcase };

export default function HomePage() {
  const { me, unread } = useSession();
  const profile = useApi<Profile>("profile");
  const resumes = useApi<Resume[]>("resumes");
  const jobs = useApi<{ items: JobSummary[]; total: number }>("jobs", { limit: 6 });
  const reminders = useApi<Reminder[]>("reminders", { status: "scheduled", limit: 5 });
  const roadmaps = useApi<RoadmapSummary[]>("roadmaps");

  const loading = profile.loading || resumes.loading || jobs.loading || reminders.loading || roadmaps.loading;
  const anyError = profile.error || resumes.error || jobs.error || reminders.error || roadmaps.error;

  const actions: Action[] = [];
  if (profile.data && !profile.data.onboarded_at) {
    actions.push({ key: "onboard", href: "/onboarding", title: "Finish setting up", detail: "Add target roles, domains and weekly study time.", icon: UserRound });
  }
  if (resumes.data && resumes.data.length === 0) {
    actions.push({ key: "resume", href: "/resumes", title: "Add a resume", detail: "Upload a PDF or DOCX, or paste text, so jobs can be compared with your evidence.", icon: FileText });
  }
  const parsedVersions = (resumes.data || []).flatMap((r) => r.versions).filter((v) => v.parse_status === "parsed");
  if (resumes.data && resumes.data.length > 0 && parsedVersions.length === 0) {
    actions.push({ key: "resume-parse", href: "/resumes", title: "Fix your resume upload", detail: "None of your resume versions could be read yet.", icon: FileText });
  }
  if (jobs.data && jobs.data.total === 0) {
    actions.push({ key: "job", href: "/jobs/new", title: "Analyze a job posting", detail: "Paste a posting to see its requirements with quoted evidence.", icon: Briefcase });
  }
  for (const j of (jobs.data?.items || []).filter((j) => !j.latest_analysis_status).slice(0, 3)) {
    actions.push({ key: `analyze-${j.id}`, href: `/jobs/${j.id}`, title: `Analysis missing: ${jobTitle(j)}`, detail: "This job has no completed analysis. Open it to re-run.", icon: Briefcase });
  }
  if (unread > 0) {
    actions.push({ key: "notif", href: "/notifications", title: `${unread} unread notification${unread === 1 ? "" : "s"}`, detail: "Reminders and updates waiting for you.", icon: Bell });
  }
  const activePlans = (roadmaps.data || []).filter((r) => r.status === "active");
  if (roadmaps.data && roadmaps.data.length === 0 && jobs.data && jobs.data.total > 0) {
    actions.push({ key: "plan", href: "/preparation", title: "Create a preparation plan", detail: "Turn a job's gaps into a weekly plan.", icon: Route });
  }

  const name = me?.user.display_name;

  return (
    <>
      <PageHeader title={name ? `Hello, ${name}` : "Home"} description="What to do next, based on what is in your account." />
      {anyError ? <div className="mb-6"><ErrorState error={anyError} title="Some information could not be loaded" /></div> : null}

      <section aria-labelledby="next-actions" className="mb-12">
        <SectionTitle id="next-actions">Next steps</SectionTitle>
        {loading && !actions.length ? <LoadingBlock rows={2} label="Loading your next steps" /> : null}
        {!loading && !actions.length ? (
          <p className="text-sm text-muted">Nothing needs attention right now.</p>
        ) : null}
        {actions.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {actions.map((a) => {
              const Icon = a.icon;
              return (
                <li key={a.key}>
                  <Link href={a.href} className="group flex h-full items-start gap-3 rounded-lg border border-line bg-surface p-4 hover:border-line-strong">
                    <Icon aria-hidden className="size-5 text-accent mt-0.5 shrink-0" />
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
                        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
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
