"use client";

import Link from "next/link";
import { useState } from "react";
import { Bell, BellDot, Check, X } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatDateTime, humanize, relativeTime } from "@/lib/format";
import type { Notification } from "@/lib/types";
import { useSession } from "@/components/shell/session";
import { Badge, Button, EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";

function safeLink(link: string | null): string | null {
  if (!link) return null;
  return link.startsWith("/") && !link.startsWith("//") ? link : null;
}

export default function NotificationsPage() {
  const { notify } = useToast();
  const { refreshUnread } = useSession();
  const list = useApi<{ items: Notification[]; unread: number }>("notifications", { limit: 200 });
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (key: string, path: string, ok?: string) => {
    setBusy(key);
    try {
      await apiFetch(path, { method: "POST" });
      if (ok) notify("ok", ok);
      list.reload();
      refreshUnread();
    } catch (e) {
      notify("error", (e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  const items = [...(list.data?.items || [])].sort((a, b) => Number(Boolean(a.read_at)) - Number(Boolean(b.read_at)));

  return (
    <>
      <PageHeader title="Notifications" description="Reminders and updates inside Elevate. Email and push delivery are not available in this version."
        actions={list.data?.unread ? <Button size="sm" loading={busy === "all"} onClick={() => act("all", "notifications/read-all", "All marked as read")}><Check aria-hidden className="size-4" />Mark all read</Button> : null} />
      {list.loading && !list.data ? <LoadingBlock rows={3} label="Loading notifications" /> : null}
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} title="Could not load notifications" /> : null}
      {list.data && !items.length ? <EmptyState title="No notifications" icon={<Bell className="size-4" />}>Reminders you schedule will appear here when they are due.</EmptyState> : null}
      {items.length ? (
        <ul className="divide-y divide-line border-y border-line">
          {items.map((n) => {
            const link = safeLink(n.link);
            const unread = !n.read_at;
            return (
              <li key={n.id} className="py-4 flex items-start gap-3">
                {unread ? <BellDot aria-hidden className="size-4 text-accent mt-1 shrink-0" /> : <Bell aria-hidden className="size-4 text-muted mt-1 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className={unread ? "font-semibold" : "font-medium text-ink-2"}>{n.title}</p>
                    {unread ? <Badge tone="accent">Unread</Badge> : null}
                    <Badge>{humanize(n.kind)}</Badge>
                  </div>
                  {n.body ? <p className="text-sm text-ink-2 mt-1 prewrap">{n.body}</p> : null}
                  <p className="text-[13px] text-muted mt-1" title={formatDateTime(n.created_at)}>{relativeTime(n.created_at)}</p>
                  {link ? <Link href={link} className="text-sm text-accent underline underline-offset-4" onClick={() => unread && act(n.id, `notifications/${n.id}/read`)}>Open</Link> : null}
                </div>
                <div className="flex flex-col sm:flex-row gap-1">
                  {unread ? <Button size="sm" variant="ghost" loading={busy === n.id} onClick={() => act(n.id, `notifications/${n.id}/read`)}>Mark read</Button> : null}
                  <Button size="sm" variant="ghost" aria-label={`Dismiss ${n.title}`} loading={busy === `d${n.id}`} onClick={() => act(`d${n.id}`, `notifications/${n.id}/dismiss`)}><X aria-hidden className="size-4" />Dismiss</Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}
