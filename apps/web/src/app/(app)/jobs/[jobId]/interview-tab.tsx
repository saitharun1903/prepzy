"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { interviewResearchLinks } from "@/lib/research";
import { useApi } from "@/lib/hooks";
import { formatDate, humanize } from "@/lib/format";
import type { InterviewSessionSummary } from "@/lib/types";
import { Badge, ButtonLink, EmptyState, ErrorState, LoadingBlock, SectionTitle } from "@/components/ui/primitives";

export function InterviewTab({ jobId, company, title }: { jobId: string; company?: string | null; title?: string | null }) {
  const s = useApi<InterviewSessionSummary[]>("interviews");
  const mine = (s.data || []).filter((x) => x.job_id === jobId);
  const links = interviewResearchLinks(company, title);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <ButtonLink href={`/interviews/new?job_id=${jobId}`} variant="primary">Practice for this job</ButtonLink>
        <p className="text-sm text-muted">Questions are generated for practice from this job&apos;s requirements. They are not the employer&apos;s questions.</p>
      </div>
      <section aria-labelledby="iv-h">
        <SectionTitle id="iv-h">Practice sessions for this job</SectionTitle>
        {s.loading && !s.data ? <LoadingBlock rows={2} /> : null}
        {s.error ? <ErrorState error={s.error} onRetry={s.reload} /> : null}
        {s.data && !mine.length ? <EmptyState title="No sessions yet">Start a practice session to rehearse answers and get rubric-based feedback.</EmptyState> : null}
        {mine.length ? (
          <ul className="divide-y divide-line border-y border-line">
            {mine.map((x) => (
              <li key={x.id} className="py-3 flex flex-wrap items-center gap-3">
                <Link href={`/interviews/${x.id}`} className="font-medium hover:underline underline-offset-4 break-words">{x.title}</Link>
                <Badge>{humanize(x.status)}</Badge>
                <span className="text-sm text-muted ml-auto">{x.answered} of {x.questions} answered · {formatDate(x.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {links.length ? (
        <section aria-labelledby="research-h" className="rounded-xl border border-line bg-surface surface-premium p-4 sm:p-5">
          <SectionTitle id="research-h">Real interview experiences</SectionTitle>
          <p className="text-sm text-ink-2 -mt-1 mb-3">Read what past candidates say about {company || "this company"}&apos;s interviews. Each link opens a search on that site in a new tab; Prepzy doesn&apos;t copy or summarise these sites.</p>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {links.map((l) => (
              <li key={l.id}>
                <a href={l.url} target="_blank" rel="noopener noreferrer nofollow"
                  className="group flex items-center gap-3 rounded-lg border border-line bg-white px-3.5 py-3 lift">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-ink">{l.label}</span>
                    <span className="block text-[12px] text-muted">{l.hint}</span>
                  </span>
                  <ArrowUpRight aria-hidden className="size-4 text-gold-ink group-hover:text-accent" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
