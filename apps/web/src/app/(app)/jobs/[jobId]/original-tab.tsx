"use client";

import { useState } from "react";
import { ApiError, apiFetch } from "@/lib/api";
import { formatDateTime, humanize } from "@/lib/format";
import type { JobDetail } from "@/lib/types";
import { Button, EmptyState, ErrorState, SectionTitle } from "@/components/ui/primitives";

export function OriginalTab({ detail }: { detail: JobDetail }) {
  const latest = detail.snapshots[0];
  const [viewing, setViewing] = useState<{ id: string; version: number; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const open = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const s = await apiFetch<{ id: string; version: number; text: string }>(`jobs/${detail.job.id}/snapshots/${id}`);
      setViewing(s);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  const text = viewing ? viewing.text : detail.latest_snapshot_text;
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="orig-h">
        <SectionTitle id="orig-h" actions={viewing ? <Button size="sm" variant="ghost" onClick={() => setViewing(null)}>Show latest</Button> : null}>
          {viewing ? `Snapshot version ${viewing.version}` : latest ? `Latest captured text (version ${latest.version})` : "Captured text"}
        </SectionTitle>
        {text ? (
          <div className="rounded-lg border border-line bg-surface p-4 sm:p-6 max-h-[70vh] overflow-auto">
            <p className="prewrap text-[15px] leading-relaxed text-ink max-w-[72ch]">{text}</p>
          </div>
        ) : <EmptyState title="No captured text" />}
      </section>
      {error ? <ErrorState error={error} title="Could not load that snapshot" /> : null}
      <section aria-labelledby="snaps-h">
        <SectionTitle id="snaps-h">Snapshots ({detail.snapshots.length})</SectionTitle>
        <p className="text-[13px] text-muted mb-2">A new snapshot is stored when the posting text changes. Analyses refer to a specific snapshot.</p>
        <ul className="divide-y divide-line border-y border-line">
          {detail.snapshots.map((s) => (
            <li key={s.id} className="py-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="font-medium">Version {s.version}</span>
              <span className="text-ink-2">{humanize(s.capture_method)} capture</span>
              <span className="text-muted">{formatDateTime(s.captured_at)}</span>
              <span className="text-muted">{s.chars.toLocaleString()} characters</span>
              {s.page_title ? <span className="text-muted truncate max-w-full">{s.page_title}</span> : null}
              <Button size="sm" variant="ghost" className="ml-auto" loading={busy === s.id} onClick={() => open(s.id)}>View</Button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
