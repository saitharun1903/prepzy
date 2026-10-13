"use client";

import Link from "next/link";
import { useApi } from "@/lib/hooks";
import { formatDate, humanize } from "@/lib/format";
import type { InterviewSessionSummary } from "@/lib/types";
import { Badge, ButtonLink, EmptyState, ErrorState, LoadingBlock, SectionTitle } from "@/components/ui/primitives";

export function InterviewTab({ jobId }: { jobId: string }) {
  const s = useApi<InterviewSessionSummary[]>("interviews");
  const mine = (s.data || []).filter((x) => x.job_id === jobId);
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
    </div>
  );
}
