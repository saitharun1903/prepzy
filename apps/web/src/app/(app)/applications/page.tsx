"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, Search } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { APP_STATUSES, formatDate, humanize, jobTitle, relativeTime } from "@/lib/format";
import type { Application, ApplicationPage } from "@/lib/types";
import { Badge, Button, EmptyState, ErrorState, Input, LoadingBlock, PageHeader, Select, cx } from "@/components/ui/primitives";

export default function ApplicationsPage() {
  const [statuses, setStatuses] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("updated");
  const [items, setItems] = useState<Application[]>([]);
  const [page, setPage] = useState<ApplicationPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    apiFetch<ApplicationPage>("applications", { query: { status: statuses, q: query || undefined, sort, limit: 25 }, signal: ctrl.signal })
      .then((p) => { setPage(p); setItems(p.items); })
      .catch((e) => { if ((e as Error).name !== "AbortError") setError(e as ApiError); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [statuses, query, sort, tick]);

  const loadMore = async () => {
    if (!page?.next_cursor) return;
    setMore(true);
    try {
      const p = await apiFetch<ApplicationPage>("applications", { query: { status: statuses, q: query || undefined, sort, limit: 25, cursor: page.next_cursor } });
      setItems((xs) => [...xs, ...p.items]);
      setPage(p);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setMore(false);
    }
  };

  const counts = page?.counts || {};
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);
  const help = page?.status_help || {};

  return (
    <>
      <PageHeader title="Applications" description="Applications you are tracking. Elevate records what you tell it; it never submits applications." />

      <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2 mb-4">
        <button type="button" aria-pressed={!statuses.length} onClick={() => setStatuses([])}
          className={cx("h-8 rounded-full border px-3 text-sm", !statuses.length ? "border-accent bg-accent-soft" : "border-line-strong text-ink-2")}>
          All <span className="text-muted">{totalAll}</span>
        </button>
        {APP_STATUSES.map((s) => {
          const on = statuses.includes(s);
          return (
            <button key={s} type="button" aria-pressed={on} title={help[s]} onClick={() => setStatuses(on ? statuses.filter((x) => x !== s) : [...statuses, s])}
              className={cx("h-8 rounded-full border px-3 text-sm inline-flex items-center gap-1.5", on ? "border-accent bg-accent-soft" : "border-line-strong text-ink-2")}>
              {on ? <CheckCircle2 aria-hidden className="size-3.5 text-accent" /> : null}
              {humanize(s)} <span className="text-muted">{counts[s] || 0}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <form role="search" className="flex gap-2 flex-1" onSubmit={(e: FormEvent) => { e.preventDefault(); setQuery(q.trim()); }}>
          <label htmlFor="app-q" className="sr-only">Search by job title or company</label>
          <Input id="app-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title or company" maxLength={200} />
          <Button type="submit"><Search aria-hidden className="size-4" />Search</Button>
        </form>
        <div className="flex items-center gap-2">
          <label htmlFor="app-sort" className="text-sm text-muted whitespace-nowrap">Sort by</label>
          <Select id="app-sort" className="w-auto" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="updated">Recently updated</option>
            <option value="created">Recently created</option>
            <option value="next_action">Next action date</option>
          </Select>
        </div>
      </div>

      {statuses.length === 1 && help[statuses[0]] ? <p className="text-sm text-ink-2 mb-4">{humanize(statuses[0])}: {help[statuses[0]]}</p> : null}
      <p className="text-[13px] text-muted mb-3" aria-live="polite">{page && !loading ? `${page.total} application${page.total === 1 ? "" : "s"}` : ""}</p>

      {error ? <div className="mb-4"><ErrorState error={error} onRetry={() => setTick((t) => t + 1)} title="Could not load applications" /></div> : null}
      {loading ? <LoadingBlock rows={4} label="Loading applications" /> : null}
      {!loading && !error && !items.length ? (
        totalAll ? <EmptyState title="No applications match">Change the filters or search.</EmptyState> : (
          <EmptyState title="No applications yet">Open a job and use its Application tab to start tracking.</EmptyState>
        )
      ) : null}

      {!loading && items.length ? (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-sm min-w-[640px] mx-4 sm:mx-0">
            <caption className="sr-only">Applications</caption>
            <thead>
              <tr className="text-left text-muted border-b border-line">
                <th scope="col" className="py-2 pr-4 font-medium">Job</th>
                <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                <th scope="col" className="py-2 pr-4 font-medium">Applied</th>
                <th scope="col" className="py-2 pr-4 font-medium">Next action</th>
                <th scope="col" className="py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="py-3 pr-4 align-top">
                    <Link href={`/jobs/${a.job_id}?tab=application`} className="font-medium hover:underline underline-offset-4">{jobTitle(a.job)}</Link>
                    {a.job?.company ? <div className="text-[13px] text-muted">{a.job.company}</div> : null}
                    {a.cycle > 1 ? <div className="text-[12px] text-muted">Cycle {a.cycle}</div> : null}
                  </td>
                  <td className="py-3 pr-4 align-top"><Badge tone={["rejected", "withdrawn", "closed"].includes(a.status) ? "neutral" : "accent"}>{humanize(a.status)}</Badge></td>
                  <td className="py-3 pr-4 align-top text-ink-2">{formatDate(a.applied_on)}</td>
                  <td className="py-3 pr-4 align-top text-ink-2">{a.next_action ? <>{a.next_action}{a.next_action_on ? <div className="text-[13px] text-muted">{formatDate(a.next_action_on)}</div> : null}</> : "—"}</td>
                  <td className="py-3 align-top text-muted whitespace-nowrap">{relativeTime(a.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {page?.next_cursor && !loading ? <div className="mt-6 flex justify-center"><Button onClick={loadMore} loading={more}>Load more</Button></div> : null}
    </>
  );
}
