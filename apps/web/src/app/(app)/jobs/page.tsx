"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Bookmark, Search } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { humanize, jobTitle, relativeTime } from "@/lib/format";
import type { JobSummary } from "@/lib/types";
import { Badge, Button, ButtonLink, EmptyState, ErrorState, Input, LoadingBlock, PageHeader, cx } from "@/components/ui/primitives";

type Page = { items: JobSummary[]; next_cursor: string | null; total: number };

export default function JobsPage() {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState({ q: "", saved: false });
  const [items, setItems] = useState<JobSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    apiFetch<Page>("jobs", { query: { q: applied.q || undefined, saved: applied.saved ? true : undefined, limit: 20 }, signal: ctrl.signal })
      .then((p) => { setItems(p.items); setCursor(p.next_cursor); setTotal(p.total); })
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(e as ApiError); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [applied, tick]);

  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const p = await apiFetch<Page>("jobs", { query: { q: applied.q || undefined, saved: applied.saved ? true : undefined, limit: 20, cursor } });
      setItems((xs) => [...xs, ...p.items]);
      setCursor(p.next_cursor);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setMore(false);
    }
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setApplied((a) => ({ ...a, q: q.trim() }));
  };

  return (
    <>
      <PageHeader title="Jobs" description="Postings you have captured or pasted, with their analysis."
        actions={<ButtonLink href="/jobs/new" variant="primary">Analyze a job</ButtonLink>} />

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <form role="search" onSubmit={onSearch} className="flex gap-2 flex-1">
          <label htmlFor="job-q" className="sr-only">Search jobs by title or company</label>
          <Input id="job-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title or company" maxLength={200} />
          <Button type="submit"><Search aria-hidden className="size-4" />Search</Button>
        </form>
        <div role="group" aria-label="Filter" className="flex gap-1 rounded-md border border-line p-1 self-start">
          {[{ v: false, l: "All" }, { v: true, l: "Saved" }].map((o) => (
            <button key={o.l} type="button" aria-pressed={applied.saved === o.v} onClick={() => setApplied((a) => ({ ...a, saved: o.v }))}
              className={cx("h-8 px-3 rounded text-sm", applied.saved === o.v ? "bg-surface-2 text-ink font-medium" : "text-muted hover:text-ink")}>
              {o.l}
            </button>
          ))}
        </div>
      </div>

      <div aria-live="polite" className="text-[13px] text-muted mb-3">
        {total !== null && !loading ? `${total} job${total === 1 ? "" : "s"}${applied.q ? ` matching "${applied.q}"` : ""}` : null}
      </div>

      {error ? <div className="mb-4"><ErrorState error={error} onRetry={() => setTick((t) => t + 1)} title="Could not load jobs" /></div> : null}
      {loading ? <LoadingBlock rows={4} label="Loading jobs" /> : null}
      {!loading && !error && !items.length ? (
        applied.q || applied.saved ? (
          <EmptyState title="No jobs match">Try a different search or filter.</EmptyState>
        ) : (
          <EmptyState title="No jobs yet" action={<ButtonLink href="/jobs/new" variant="primary">Analyze a job</ButtonLink>}>
            Paste a job posting here, or click the Prepzy extension on a job page.
          </EmptyState>
        )
      ) : null}

      {!loading && items.length ? (
        <ul className="divide-y divide-line border-y border-line">
          {items.map((j) => (
            <li key={j.id} className="py-4 flex flex-col sm:flex-row sm:items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/jobs/${j.id}`} className="font-medium text-ink hover:underline underline-offset-4 break-words">{jobTitle(j)}</Link>
                  {j.saved ? <Badge icon={<Bookmark aria-hidden className="size-3" />}>Saved</Badge> : null}
                  {j.availability === "closed" ? <Badge tone="warn">Closed</Badge> : null}
                </div>
                <p className="text-sm text-ink-2 mt-0.5">
                  {[j.company, ...(j.domains || []).slice(0, 2).map((d) => String((d as { label?: string }).label ?? ""))].filter(Boolean).join(" · ") || "Company not stated"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {j.latest_analysis_status === "partial" ? <Badge tone="warn">Partial analysis</Badge> : null}
                {!j.latest_analysis_status ? <Badge tone="neutral">Not analyzed</Badge> : null}
                {j.application_status ? <Badge tone="accent">{humanize(j.application_status)}</Badge> : null}
                <span className="text-[13px] text-muted">Updated {relativeTime(j.updated_at)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {cursor && !loading ? (
        <div className="mt-6 flex justify-center">
          <Button onClick={loadMore} loading={more}>Load more</Button>
        </div>
      ) : null}
    </>
  );
}
