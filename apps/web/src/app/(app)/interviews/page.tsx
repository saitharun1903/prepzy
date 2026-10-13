"use client";

import Link from "next/link";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatDate, humanize } from "@/lib/format";
import type { InterviewSessionSummary } from "@/lib/types";
import { Badge, Button, ButtonLink, EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

export default function InterviewsPage() {
  const { notify } = useToast();
  const s = useApi<InterviewSessionSummary[]>("interviews");
  const [del, setDel] = useState<InterviewSessionSummary | null>(null);

  return (
    <>
      <PageHeader title="Interview practice" description="Generated practice questions with rubric-based feedback from the local model. These are not real company questions, and code is never executed."
        actions={<ButtonLink href="/interviews/new" variant="primary">New session</ButtonLink>} />
      {s.loading && !s.data ? <LoadingBlock rows={3} label="Loading sessions" /> : null}
      {s.error ? <ErrorState error={s.error} onRetry={s.reload} title="Could not load sessions" /> : null}
      {s.data && !s.data.length ? (
        <EmptyState title="No practice sessions yet" action={<ButtonLink href="/interviews/new" variant="primary">Start practising</ButtonLink>}>
          Practise for a specific job, or generally for your target domains.
        </EmptyState>
      ) : null}
      {s.data?.length ? (
        <ul className="divide-y divide-line border-y border-line">
          {s.data.map((x) => (
            <li key={x.id} className="py-4 flex flex-col sm:flex-row sm:items-center gap-2">
              <div className="min-w-0 flex-1">
                <Link href={`/interviews/${x.id}`} className="font-medium hover:underline underline-offset-4 break-words">{x.title}</Link>
                <p className="text-[13px] text-muted mt-0.5">
                  {humanize(String(x.config.difficulty || ""))} · {String(x.config.mode) === "timed" ? `timed, ${x.config.minutes} min` : "practice"} · created {formatDate(x.created_at)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={x.status === "failed" ? "danger" : x.status === "completed" ? "ok" : "neutral"}>{humanize(x.status)}</Badge>
                <span className="text-sm text-muted">{x.answered} of {x.questions} answered</span>
                <Button size="sm" variant="ghost" aria-label={`Delete ${x.title}`} onClick={() => setDel(x)}><Trash2 aria-hidden className="size-4" /></Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog open={Boolean(del)} onClose={() => setDel(null)} title="Delete this session?" description="Its questions, your answers and feedback are permanently deleted."
        footer={<><Button onClick={() => setDel(null)}>Cancel</Button><Button variant="danger" onClick={async () => {
          if (!del) return;
          try {
            await apiFetch(`interviews/${del.id}`, { method: "DELETE" });
            notify("ok", "Session deleted");
            s.reload();
          } catch (e) {
            notify("error", (e as ApiError).message);
          }
          setDel(null);
        }}>Delete session</Button></>} />
    </>
  );
}
