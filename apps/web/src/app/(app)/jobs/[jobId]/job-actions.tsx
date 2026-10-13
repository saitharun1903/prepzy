"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Bookmark, BookmarkX, RefreshCw, Trash2 } from "lucide-react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import type { JobDetail } from "@/lib/types";
import { Button, ErrorState } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

export function JobActions({ detail, onChanged }: { detail: JobDetail; onChanged: () => void }) {
  const router = useRouter();
  const { notify } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<ApiError | null>(null);
  const [unverified, setUnverified] = useState<ApiError | null>(null);
  const job = detail.job;
  const analysing = detail.active_operations.length > 0;

  const act = async (name: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(name);
    try {
      await fn();
      notify("ok", ok);
      onChanged();
    } catch (e) {
      const err = e as ApiError;
      if (err?.code === "email_unverified") setUnverified(err);
      else notify("error", err.message, err.requestId ? `Request ID ${err.requestId}` : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Button size="sm" loading={busy === "save"}
        onClick={() => act("save", () => apiFetch(`jobs/${job.id}/save`, { method: job.saved ? "DELETE" : "POST" }), job.saved ? "Removed from saved jobs" : "Job saved")}>
        {job.saved ? <BookmarkX aria-hidden className="size-4" /> : <Bookmark aria-hidden className="size-4" />}
        {job.saved ? "Unsave" : "Save"}
      </Button>
      <Button size="sm" loading={busy === "reanalyze"} disabled={analysing || !detail.snapshots.length}
        title={analysing ? "An analysis is already running" : undefined}
        onClick={() => act("reanalyze", () => apiFetch(`jobs/${job.id}/reanalyze`, { method: "POST", idempotencyKey: newIdempotencyKey() }), "Re-analysis queued")}>
        <RefreshCw aria-hidden className="size-4" />Re-analyze
      </Button>
      <Button size="sm" variant="ghost" onClick={() => { setDeleteError(null); setConfirmDelete(true); }}>
        <Trash2 aria-hidden className="size-4" />Delete
      </Button>

      <Dialog open={Boolean(unverified)} onClose={() => setUnverified(null)} title="Confirm your email first"
        footer={<Button onClick={() => setUnverified(null)}>Close</Button>}>
        <ErrorState error={unverified} />
      </Dialog>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this job permanently?"
        description="This cannot be undone."
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)} data-autofocus>Keep the job</Button>
            <Button variant="danger" loading={busy === "delete"} onClick={async () => {
              setBusy("delete");
              setDeleteError(null);
              try {
                await apiFetch(`jobs/${job.id}`, { method: "DELETE" });
                notify("ok", "Job deleted");
                router.replace("/jobs");
              } catch (e) {
                setDeleteError(e as ApiError);
                setBusy(null);
              }
            }}>Delete job</Button>
          </>
        }>
        <p className="text-sm text-ink-2">Deleting removes, for this job:</p>
        <ul className="mt-2 list-disc pl-5 text-sm text-ink-2 flex flex-col gap-0.5">
          <li>all captured text snapshots and analyses, including your corrections</li>
          <li>match reports</li>
          <li>notes, applications and their status history</li>
          <li>reminders linked to the job</li>
        </ul>
        <p className="mt-3 text-sm text-ink-2">Any analysis still running for this job is cancelled. Your resumes, profile and preparation plans are not deleted.</p>
        {deleteError ? <div className="mt-3"><ErrorState error={deleteError} title="Could not delete" /></div> : null}
      </Dialog>
    </>
  );
}
