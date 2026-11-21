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
import { TailorTab } from "./tailor-tab";
import { InterviewTab } from "./interview-tab";
import { AskTab } from "./ask-tab";
import { ApplicationTab } from "./application-tab";

// Six tabs, in the order people use them. Related screens share a tab with a small switch inside.
const TABS = [
  { id: "match", label: "Your match", hint: "How well you fit this job, and what to do next." },
  { id: "resume", label: "Resume", hint: "Get a one-page resume for this job, or fix lines in your current one." },
  { id: "interview", label: "Interview prep", hint: "Practice questions and real interview experiences." },
  { id: "ask", label: "Ask AI", hint: "Ask anything about this job." },
  { id: "application", label: "Track", hint: "Note when you applied, interviews and follow-ups." },
  { id: "details", label: "Details", hint: "What Prepzy read from the posting. Fix anything it got wrong." },
];
// Old links (?tab=guidance, ?tab=requirements …) keep working.
const LEGACY: Record<string, [string, string]> = {
  guidance: ["resume", "fix"], requirements: ["details", "requirements"], overview: ["details", "summary"], original: ["details", "original"],
};
const SUBVIEWS: Record<string, { id: string; label: string }[]> = {
  resume: [{ id: "tailored", label: "Tailored resume" }, { id: "fix", label: "Fix my resume" }],
  details: [{ id: "summary", label: "Summary" }, { id: "requirements", label: "Requirements" }, { id: "original", label: "Original text" }],
};

function SubNav({ tab, value, onChange }: { tab: string; value: string; onChange: (v: string) => void }) {
  const items = SUBVIEWS[tab];
  if (!items) return null;
  return (
    <div role="tablist" aria-label="View" className="mb-6 inline-flex rounded-xl bg-surface-2 p-1 gap-1">
      {items.map((it) => (
        <button key={it.id} type="button" role="tab" aria-selected={value === it.id} onClick={() => onChange(it.id)}
          className={"rounded-lg px-3.5 py-1.5 text-sm font-medium transition " + (value === it.id ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink")}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

function Workspace({ jobId }: { jobId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const rawTab = sp.get("tab") ?? "";
  const [tabParam, legacyView] = LEGACY[rawTab] ?? [rawTab, null];
  const viewParam = sp.get("view") ?? legacyView;
  const [tab, setTab] = useState(TABS.some((t) => t.id === tabParam) ? (tabParam as string) : "match");
  const defaultView = (t: string) => SUBVIEWS[t]?.[0]?.id ?? "";
  const [view, setView] = useState<string>(viewParam && SUBVIEWS[tab]?.some((v) => v.id === viewParam) ? viewParam : defaultView(tab));
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const detail = useApi<JobDetail>(`jobs/${jobId}`, analysisId ? { analysis_id: analysisId } : undefined);

  useEffect(() => {
    if (tabParam && TABS.some((t) => t.id === tabParam)) {
      setTab(tabParam);
      setView(viewParam && SUBVIEWS[tabParam]?.some((v) => v.id === viewParam) ? viewParam : (SUBVIEWS[tabParam]?.[0]?.id ?? ""));
    }
  }, [tabParam, viewParam]);

  const navigate = useCallback((id: string, v?: string) => {
    const [t, lv] = LEGACY[id] ?? [id, null];
    const nextView = v ?? lv ?? SUBVIEWS[t]?.[0]?.id ?? "";
    setTab(t);
    setView(nextView);
    const q = new URLSearchParams(sp.toString());
    q.set("tab", t);
    if (SUBVIEWS[t]) q.set("view", nextView); else q.delete("view");
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }, [pathname, router, sp]);
  const changeTab = useCallback((id: string) => navigate(id), [navigate]);

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
      <p className="mt-3 mb-5 text-[13.5px] text-muted">{TABS.find((t) => t.id === tab)?.hint}</p>
      <TabPanel id={tab}>
        <SubNav tab={tab} value={view} onChange={(v) => navigate(tab, v)} />
        {tab === "details" && view === "summary" ? <OverviewTab detail={d} reload={detail.reload} analysisId={analysisId} setAnalysisId={setAnalysisId} /> : null}
        {tab === "details" && view === "requirements" ? <RequirementsTab detail={d} reload={detail.reload} /> : null}
        {tab === "details" && view === "original" ? <OriginalTab detail={d} /> : null}
        {tab === "match" ? <MatchTab jobId={jobId} hasAnalysis={Boolean(d.analysis)} onJobChanged={detail.reload} onGoTo={changeTab} /> : null}
        {tab === "resume" && view === "fix" ? <GuidanceTab jobId={jobId} /> : null}
        {tab === "resume" && view === "tailored" ? <TailorTab jobId={jobId} jobTitle={d.analysis?.result.fields.title?.value || d.job.title || ""} /> : null}
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
