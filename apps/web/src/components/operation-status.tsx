"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, CircleSlash, Clock, Loader2 } from "lucide-react";
import { useOperation } from "@/lib/hooks";
import { humanize } from "@/lib/format";
import { isApiError } from "@/lib/api";
import type { Operation } from "@/lib/types";
import { Button, cx } from "./ui/primitives";
import { useToast } from "./ui/toast";

const STATE_LABEL: Record<string, string> = {
  queued: "Waiting in queue",
  running: "In progress",
  cancellation_requested: "Cancelling",
  succeeded: "Finished",
  partially_succeeded: "Finished with limitations",
  failed: "Failed",
  timed_out: "Timed out",
  cancelled: "Cancelled",
};

/** Shows the REAL state + stage of a durable operation, with cancel/retry. No fake progress. */
export function OperationStatus<R = Record<string, unknown>>({ opId, label, onDone, compact }: {
  opId: string; label: string; onDone?: (op: Operation<R>) => void; compact?: boolean;
}) {
  const { op, error, cancel, retry } = useOperation<R>(opId, onDone);
  const [busy, setBusy] = useState<"cancel" | "retry" | null>(null);
  const { notify } = useToast();

  const run = async (kind: "cancel" | "retry") => {
    setBusy(kind);
    try {
      if (kind === "cancel") await cancel();
      else await retry();
    } catch (e) {
      notify("error", isApiError(e) ? e.message : "Request failed", undefined);
    } finally {
      setBusy(null);
    }
  };

  const state = op?.state ?? "queued";
  const active = !op || !op.terminal;
  const Icon = active ? Loader2 : state === "succeeded" ? CheckCircle2 : state === "cancelled" ? CircleSlash : state === "partially_succeeded" ? AlertTriangle : state === "timed_out" ? Clock : AlertTriangle;
  const tone = active ? "text-accent" : state === "succeeded" ? "text-ok" : state === "cancelled" ? "text-muted" : state === "partially_succeeded" ? "text-warn" : "text-danger";

  return (
    <div className={cx("rounded-md border border-line bg-surface-2/60 text-sm", compact ? "px-3 py-2" : "px-4 py-3")}>
      <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Icon aria-hidden className={cx("size-4 shrink-0", tone, active && "spin")} />
        <span className="font-medium text-ink">{label}</span>
        <span className="text-ink-2">
          {op ? STATE_LABEL[state] ?? humanize(state) : "Checking status"}
          {op && active && op.stage && op.stage !== state ? <> · stage: <span className="font-medium">{humanize(op.stage)}</span></> : null}
          {op && op.attempt > 1 && active ? <> · attempt {op.attempt} of {op.max_attempts}</> : null}
        </span>
        <span className="ml-auto flex gap-2">
          {op && active && state !== "cancellation_requested" ? (
            <Button size="sm" variant="ghost" loading={busy === "cancel"} onClick={() => run("cancel")}>Cancel</Button>
          ) : null}
          {op && (state === "failed" || state === "timed_out") ? (
            <Button size="sm" loading={busy === "retry"} onClick={() => run("retry")}>Retry</Button>
          ) : null}
        </span>
      </div>
      {state === "cancellation_requested" ? (
        <p className="mt-1.5 text-[13px] text-ink-2">
          Cancellation requested. A model call that has already started cannot be interrupted, so it may finish before the
          operation stops. Its result will be recorded honestly either way.
        </p>
      ) : null}
      {op?.error && !active ? (
        <p className="mt-1.5 text-[13px] text-danger break-words">{op.error.message} <span className="text-muted">({op.error.code})</span></p>
      ) : null}
      {error ? <p className="mt-1.5 text-[13px] text-danger">Could not check status: {error.message}{error.retryable ? " — retrying." : ""}</p> : null}
    </div>
  );
}
