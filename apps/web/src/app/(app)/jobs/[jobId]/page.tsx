"use client";

import Link from "next/link";
import { Suspense, use, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { useApi } from "@/lib/hooks";
import { jobTitle } from "@/lib/format";
import type { JobDetail } from "@/lib/types";
import { Badge, ErrorState, LoadingBlock, PageHeader, TabPanel, Tabs } from "@/components/ui/primitives";
import { JobActions } from "./job-actions";
import { OverviewTab } from "./overview-tab";
import { RequirementsTab } from "./requirements-tab";
import { OriginalTab } from "./original-tab";
import { MatchTab } from "./match-tab";
import { GuidanceTab } from "./guidance-tab";
import { InterviewTab } from "./interview-tab";
import { AskTab } from "./ask-tab";
import { ApplicationTab } from "./application-tab";

// Ordered by what people do: see the match, close gaps, practise, apply. Reference tabs come last.
const TABS = [
  { id: "match", label: "Your match", hint: "How well your resume fits this job, and what to do next." },
  { id: "guidance", label: "Improve resume", hint: "Fixes and wording suggestions for your resume, based on this job." },
  { id: "interview", label: "Interview prep", hint: "Practice questions for this role and what past candidates were asked." },
  { id: "ask", label: "Ask AI", hint: "Ask anything about this job — answers use the posting and your resume." },
  { id: "application", label: "Track application", hint: "Record when you applied, interviews and follow-ups." },
  { id: "requirements", label: "Requirements", hint: "Every requirement Prepzy found in the posting. Fix anything it got wrong." },
  { id: "overview", label: "Job details", hint: "Salary, location, experience and other details from the posting." },
  { id: "original", label: "Original posting", hint: "The job text exactly as it was captured." },
];

function Workspace({ jobId }: { jobId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tabParam = sp.get("tab");
  const [tab, setTab] = useState(TABS.some((t) => t.id === tabParam) ? (tabParam as string) : "match");
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const detail = useApi<JobDetail>(`jobs/${jobId}`, analysisId ? { analysis_id: analysisId } : undefined);

  useEffect(() => {
    if (tabParam && TABS.some((t) => t.id === tabParam)) setTab(tabParam);
  }, [tabParam]);

  const changeTab = useCallback((id: string) => {
    setTab(id);
    const q = new URLSearchParams(sp.toString());
    q.set("tab", id);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }, [pathname, router, sp]);

  if (detail.loading && !detail.data) return <LoadingBlock rows={5} label="Loading job" />;
  if (detail.error && !detail.data) {
    return (
      <ErrorState error={detail.error} onRetry={detail.reload}
        title={detail.error.status === 404 ? "This job was not found. It may have been deleted." : "Could not load this job"} />
    );
  }
  const d = detail.data;
  if (!d) return null;
  const company = d.job.company || d.analysis?.result.fields.company?.value;

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/jobs" className="hover:underline underline-offset-4">Jobs</Link>}
        title={jobTitle(d.job)}
        description={
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {company ? <span className="text-ink-2">{company}</span> : <span className="text-muted">Company not stated</span>}
            {d.job.saved ? <Badge>Saved</Badge> : null}
            {d.job.availability === "closed" ? <Badge tone="warn">Marked closed</Badge> : null}
            {d.job.source_url ? (
              <a href={d.job.source_url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-accent underline underline-offset-4">
                Original posting <ExternalLink aria-hidden className="size-3.5" /><span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : null}
          </div>
        }
        actions={<JobActions detail={d} onChanged={detail.reload} />}
      />
      {detail.error ? <div className="mb-4"><ErrorState error={detail.error} onRetry={detail.reload} title="Could not refresh this job" /></div> : null}
      <Tabs label="Job workspace" tabs={TABS} value={tab} onChange={changeTab} />
      <p className="mt-3 mb-6 text-[13.5px] text-muted">{TABS.find((t) => t.id === tab)?.hint}</p>
      <TabPanel id={tab}>
        {tab === "overview" ? <OverviewTab detail={d} reload={detail.reload} analysisId={analysisId} setAnalysisId={setAnalysisId} /> : null}
        {tab === "requirements" ? <RequirementsTab detail={d} reload={detail.reload} /> : null}
        {tab === "original" ? <OriginalTab detail={d} /> : null}
        {tab === "match" ? <MatchTab jobId={jobId} hasAnalysis={Boolean(d.analysis)} onJobChanged={detail.reload} onGoTo={changeTab} /> : null}
        {tab === "guidance" ? <GuidanceTab jobId={jobId} /> : null}
        {tab === "interview" ? <InterviewTab jobId={jobId} company={company} title={d.analysis?.result.fields.title?.value || d.job.title} /> : null}
        {tab === "ask" ? <AskTab jobId={jobId} /> : null}
        {tab === "application" ? <ApplicationTab jobId={jobId} /> : null}
      </TabPanel>
    </>
  );
}

export default function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = use(params);
  return (
    <Suspense fallback={<LoadingBlock rows={5} label="Loading job" />}>
      <Workspace jobId={jobId} />
    </Suspense>
  );
}
