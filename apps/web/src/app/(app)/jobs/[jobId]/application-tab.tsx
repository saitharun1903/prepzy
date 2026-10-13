"use client";

import { useState } from "react";
import { Download, CircleDot, Pencil, Trash2, X } from "lucide-react";
import { ApiError, apiFetch, downloadFile } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { APP_STATUSES, formatDate, formatDateTime, humanize, relativeTime, todayISO } from "@/lib/format";
import type { Application, Note, Reminder } from "@/lib/types";
import { ResumeVersionSelect, type VersionPick } from "@/components/resume-version-select";
import {
  Badge, Button, EmptyState, ErrorState, Field, Input, LoadingBlock, Notice, SectionTitle, Select, Textarea,
} from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

const STATUS_HELP: Record<string, string> = {
  planned: "You intend to apply; nothing has been submitted.",
  applied: "You submitted an application (recorded by you).",
  screening: "The employer is reviewing / an initial screen is scheduled.",
  interviewing: "You are in interview rounds.",
  offer: "You received an offer.",
  rejected: "The employer declined.",
  withdrawn: "You withdrew.",
  closed: "The process ended for another reason (e.g. posting closed).",
};
const ENDED = ["rejected", "withdrawn", "closed"];

export function ApplicationTab({ jobId }: { jobId: string }) {
  return (
    <div className="flex flex-col gap-12">
      <ApplicationPanel jobId={jobId} />
      <NotesPanel jobId={jobId} />
      <RemindersPanel jobId={jobId} />
    </div>
  );
}

function ApplicationPanel({ jobId }: { jobId: string }) {
  const { notify } = useToast();
  const apps = useApi<Application[]>(`jobs/${jobId}/applications`);
  const [createStatus, setCreateStatus] = useState<"planned" | "applied">("planned");
  const [createPick, setCreatePick] = useState<VersionPick>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [correction, setCorrection] = useState<null | { message: string }>(null);
  const [nextAction, setNextAction] = useState<{ text: string; date: string } | null>(null);

  const current = apps.data?.[0];

  const create = async (reapply = false) => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("applications", {
        method: "POST",
        body: { job_id: jobId, status: createStatus, resume_version_id: createPick?.versionId ?? null, reapply },
      });
      notify("ok", reapply ? "New application cycle started" : "Application created");
      apps.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const patch = async (body: Record<string, unknown>, ok: string) => {
    if (!current) return false;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`applications/${current.id}`, { method: "PATCH", body: { expected_version: current.version, ...body } });
      notify("ok", ok);
      apps.reload();
      return true;
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "correction_required") setCorrection({ message: err.message });
      else setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (asCorrection = false) => {
    const ok = await patch({ status, note: statusNote.trim() || null, correction: asCorrection }, `Status changed to ${humanize(status)}`);
    if (ok) { setStatus(""); setStatusNote(""); setCorrection(null); }
  };

  if (apps.loading && !apps.data) return <LoadingBlock rows={2} label="Loading application" />;
  if (apps.error) return <ErrorState error={apps.error} onRetry={apps.reload} title="Could not load the application" />;

  return (
    <section aria-labelledby="app-h">
      <SectionTitle id="app-h">Application</SectionTitle>
      {error ? (
        <div className="mb-4">
          <ErrorState error={error} title={error.code === "stale_write" ? "This application changed elsewhere" : "Could not update"}
            onRetry={error.code === "stale_write" ? () => { setError(null); apps.reload(); } : undefined} />
        </div>
      ) : null}

      {!current ? (
        <div className="rounded-lg border border-line bg-surface p-4 flex flex-col gap-4 max-w-xl">
          <p className="text-sm text-ink-2">Track your application for this job. Elevate does not submit anything; you record what you did.</p>
          <Field label="Status">
            {(p) => (
              <Select id={p.id} value={createStatus} onChange={(e) => setCreateStatus(e.target.value as "planned" | "applied")}>
                <option value="planned">Planned — {STATUS_HELP.planned}</option>
                <option value="applied">Applied — {STATUS_HELP.applied}</option>
              </Select>
            )}
          </Field>
          <ResumeVersionSelect value={createPick} onChange={setCreatePick} label="Resume version used (optional)" allowNone noneLabel="Not recorded" />
          <div><Button variant="primary" loading={busy} onClick={() => create(false)}>Create application</Button></div>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={ENDED.includes(current.status) ? "neutral" : "accent"} icon={<CircleDot aria-hidden className="size-3" />}>{humanize(current.status)}</Badge>
            <span className="text-sm text-ink-2">{STATUS_HELP[current.status]}</span>
            {(apps.data?.length || 0) > 1 ? <span className="text-[13px] text-muted">Cycle {current.cycle}</span> : null}
          </div>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <p><span className="text-muted">Applied on: </span>{formatDate(current.applied_on)}</p>
            <p><span className="text-muted">Resume version: </span>{current.resume_version_id ? "Recorded" : "Not recorded"}</p>
            <p className="sm:col-span-2"><span className="text-muted">Next action: </span>
              {current.next_action ? `${current.next_action}${current.next_action_on ? ` · ${formatDate(current.next_action_on)}` : ""}` : "None"}
              <Button size="sm" variant="link" className="ml-2" onClick={() => setNextAction({ text: current.next_action || "", date: current.next_action_on || "" })}>Edit</Button>
            </p>
          </div>

          <div className="rounded-lg border border-line bg-surface p-4 grid gap-3 sm:grid-cols-[220px_1fr_auto] sm:items-end">
            <Field label="Change status">
              {(p) => (
                <Select id={p.id} value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">Choose…</option>
                  {APP_STATUSES.filter((s) => s !== current.status).map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Note (optional)">
              {(p) => <Input id={p.id} value={statusNote} maxLength={2000} onChange={(e) => setStatusNote(e.target.value)} />}
            </Field>
            <Button variant="primary" disabled={!status} loading={busy} onClick={() => changeStatus(false)}>Update</Button>
            {status ? <p className="sm:col-span-3 text-[13px] text-muted">{STATUS_HELP[status]}</p> : null}
          </div>

          <ApplicationResume current={current} onSave={(vid) => patch({ resume_version_id: vid }, "Resume version recorded")} />

          {ENDED.includes(current.status) ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-ink-2">This application has ended. If you are applying again, start a new cycle; the history is kept.</p>
              <Button onClick={() => create(true)} loading={busy}>Apply again</Button>
            </div>
          ) : null}

          {current.history?.length ? (
            <div>
              <p className="text-sm font-medium mb-2">Status history</p>
              <ol className="relative border-l border-line ml-1.5 flex flex-col gap-4">
                {[...current.history].reverse().map((h) => (
                  <li key={h.id} className="pl-4 relative">
                    <span aria-hidden className="absolute -left-[5px] top-1.5 size-2.5 rounded-full bg-line-strong" />
                    <p className="text-sm">
                      {h.from ? <>{humanize(h.from)} → </> : null}<span className="font-medium">{humanize(h.to)}</span>
                      {h.is_correction ? <Badge tone="warn" className="ml-2">Correction</Badge> : null}
                    </p>
                    <p className="text-[13px] text-muted">{formatDateTime(h.at)}{h.note ? ` · ${h.note}` : ""}</p>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      )}

      <Dialog open={Boolean(correction)} onClose={() => setCorrection(null)} title="Record this as a correction?"
        description={correction?.message}
        footer={<><Button onClick={() => setCorrection(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => changeStatus(true)}>Yes, record correction</Button></>}>
        <p className="text-sm text-ink-2">Moving an application backwards usually means an earlier status was recorded by mistake. It will be marked as a correction in the history.</p>
      </Dialog>

      <Dialog open={Boolean(nextAction)} onClose={() => setNextAction(null)} title="Next action"
        footer={<>
          {current?.next_action ? <Button variant="ghost" onClick={async () => { if (await patch({ clear_next_action: true }, "Next action cleared")) setNextAction(null); }}>Clear</Button> : null}
          <Button onClick={() => setNextAction(null)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={async () => {
            if (!nextAction) return;
            const ok = await patch({ next_action: nextAction.text.trim(), ...(nextAction.date ? { next_action_on: nextAction.date } : {}) }, "Next action saved");
            if (ok) setNextAction(null);
          }}>Save</Button>
        </>}>
        {nextAction ? (
          <div className="flex flex-col gap-4">
            <Field label="What is next?">{(p) => <Input id={p.id} value={nextAction.text} maxLength={300} data-autofocus onChange={(e) => setNextAction({ ...nextAction, text: e.target.value })} />}</Field>
            <Field label="By when (optional)">{(p) => <Input id={p.id} type="date" value={nextAction.date} onChange={(e) => setNextAction({ ...nextAction, date: e.target.value })} />}</Field>
            <p className="text-[13px] text-muted">To be reminded, also add a reminder below.</p>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}

function ApplicationResume({ current, onSave }: { current: Application; onSave: (vid: string) => Promise<boolean> }) {
  const [pick, setPick] = useState<VersionPick>(null);
  const [open, setOpen] = useState(false);
  if (!open) return <div><Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{current.resume_version_id ? "Change resume version used" : "Record resume version used"}</Button></div>;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <ResumeVersionSelect value={pick} onChange={setPick} label="Resume version used" />
      <Button disabled={!pick} onClick={async () => { if (pick && (await onSave(pick.versionId))) setOpen(false); }}>Save</Button>
      <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </div>
  );
}

function NotesPanel({ jobId }: { jobId: string }) {
  const { notify } = useToast();
  const notes = useApi<Note[]>(`jobs/${jobId}/notes`);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ note: Note; text: string; conflict?: string } | null>(null);
  const [deleting, setDeleting] = useState<Note | null>(null);

  const add = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await apiFetch(`jobs/${jobId}/notes`, { method: "POST", body: { body } });
      setBody("");
      notes.reload();
    } catch (e) {
      notify("error", (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await apiFetch(`notes/${editing.note.id}`, { method: "PATCH", body: { body: editing.text, expected_version: editing.note.version } });
      setEditing(null);
      notify("ok", "Note saved");
      notes.reload();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "stale_write") setEditing({ ...editing, conflict: err.message });
      else notify("error", err.message);
    } finally {
      setBusy(false);
    }
  };

  const reloadForConflict = async () => {
    if (!editing) return;
    try {
      const list = await apiFetch<Note[]>(`jobs/${jobId}/notes`);
      notes.setData(list);
      const latest = list.find((n) => n.id === editing.note.id);
      if (latest) setEditing({ note: latest, text: editing.text, conflict: undefined });
      else setEditing(null);
    } catch (e) {
      notify("error", (e as ApiError).message);
    }
  };

  return (
    <section aria-labelledby="notes-h">
      <SectionTitle id="notes-h">Notes</SectionTitle>
      <div className="flex flex-col gap-2 max-w-2xl">
        <label htmlFor="new-note" className="sr-only">New note</label>
        <Textarea id="new-note" rows={3} maxLength={20000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a note about this job" />
        <div><Button onClick={add} loading={busy && !editing} disabled={!body.trim()}>Add note</Button></div>
      </div>
      <div className="mt-5">
        {notes.loading && !notes.data ? <LoadingBlock rows={1} /> : null}
        {notes.error ? <ErrorState error={notes.error} onRetry={notes.reload} /> : null}
        {notes.data && !notes.data.length ? <p className="text-sm text-muted">No notes yet.</p> : null}
        <ul className="flex flex-col gap-3">
          {notes.data?.map((n) => (
            <li key={n.id} className="rounded-lg border border-line bg-surface p-4">
              {editing?.note.id === n.id ? (
                <div className="flex flex-col gap-2">
                  {editing.conflict ? (
                    <Notice tone="warn" title="This note was edited elsewhere">
                      {editing.conflict} Your text below is kept. Load the latest version to save over it, or cancel.
                      <div className="mt-2"><Button size="sm" onClick={reloadForConflict}>Load latest version, keep my text</Button></div>
                    </Notice>
                  ) : null}
                  <label htmlFor={`edit-${n.id}`} className="sr-only">Edit note</label>
                  <Textarea id={`edit-${n.id}`} rows={4} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" loading={busy} disabled={!editing.text.trim() || Boolean(editing.conflict)} onClick={saveEdit}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-sm prewrap">{n.body}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted">
                    <span>{n.updated_at !== n.created_at ? `Edited ${relativeTime(n.updated_at)}` : relativeTime(n.created_at)}</span>
                    <Button size="sm" variant="ghost" onClick={() => setEditing({ note: n, text: n.body })}><Pencil aria-hidden className="size-3.5" />Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(n)}><Trash2 aria-hidden className="size-3.5" />Delete</Button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
      <Dialog open={Boolean(deleting)} onClose={() => setDeleting(null)} title="Delete this note?" description="The note is permanently deleted."
        footer={<><Button onClick={() => setDeleting(null)}>Cancel</Button><Button variant="danger" onClick={async () => {
          if (!deleting) return;
          try {
            await apiFetch(`notes/${deleting.id}`, { method: "DELETE" });
            notify("ok", "Note deleted");
            notes.reload();
          } catch (e) {
            notify("error", (e as ApiError).message);
          }
          setDeleting(null);
        }}>Delete note</Button></>}>
        <p className="text-sm text-ink-2 prewrap line-clamp-4">{deleting?.body}</p>
      </Dialog>
    </section>
  );
}

function RemindersPanel({ jobId }: { jobId: string }) {
  const { notify } = useToast();
  const list = useApi<Reminder[]>("reminders", { job_id: jobId, status: "all" });
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"date" | "datetime">("date");
  const [date, setDate] = useState(todayISO());
  const [time, setTime] = useState("09:00");
  const [dt, setDt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { title: title.trim(), job_id: jobId };
      if (mode === "date") { body.due_date = date; body.remind_time = time; }
      else {
        const d = new Date(dt);
        if (Number.isNaN(d.getTime())) throw new ApiError({ status: 422, code: "validation_failed", message: "Choose a date and time." });
        body.due_at = d.toISOString();
      }
      const r = await apiFetch<Reminder>("reminders", { method: "POST", body });
      notify("ok", "Reminder scheduled", r.note || undefined);
      setTitle("");
      list.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (r: Reminder) => {
    try {
      await apiFetch(`reminders/${r.id}/cancel`, { method: "POST" });
      notify("ok", "Reminder cancelled");
      list.reload();
    } catch (e) {
      notify("error", (e as ApiError).message);
    }
  };

  return (
    <section aria-labelledby="rem-h">
      <SectionTitle id="rem-h">Reminders</SectionTitle>
      <p className="text-[13px] text-muted mb-3">Reminders appear in Elevate&apos;s notifications. Email and push delivery are not available in this version.</p>
      <div className="rounded-lg border border-line bg-surface p-4 grid gap-4 sm:grid-cols-2 max-w-2xl">
        <Field label="Reminder" className="sm:col-span-2" error={error?.fields?.title}>
          {(p) => <Input id={p.id} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Follow up with recruiter" aria-invalid={p.invalid} />}
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium mb-1.5">When</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="inline-flex items-center gap-2"><input type="radio" name="rem-mode" checked={mode === "date"} onChange={() => setMode("date")} className="accent-[var(--accent)]" />On a date (your timezone)</label>
            <label className="inline-flex items-center gap-2"><input type="radio" name="rem-mode" checked={mode === "datetime"} onChange={() => setMode("datetime")} className="accent-[var(--accent)]" />At an exact date and time</label>
          </div>
        </fieldset>
        {mode === "date" ? (
          <>
            <Field label="Date">{(p) => <Input id={p.id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
            <Field label="Remind at">{(p) => <Input id={p.id} type="time" value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
          </>
        ) : (
          <Field label="Date and time" className="sm:col-span-2">{(p) => <Input id={p.id} type="datetime-local" value={dt} onChange={(e) => setDt(e.target.value)} />}</Field>
        )}
        {error ? <div className="sm:col-span-2"><ErrorState error={error} title="Could not schedule" /></div> : null}
        <div className="sm:col-span-2"><Button variant="primary" loading={busy} disabled={!title.trim() || (mode === "date" ? !date : !dt)} onClick={create}>Add reminder</Button></div>
      </div>

      <div className="mt-5">
        {list.loading && !list.data ? <LoadingBlock rows={1} /> : null}
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.data && !list.data.length ? <EmptyState title="No reminders for this job" /> : null}
        {list.data?.length ? (
          <ul className="divide-y divide-line border-y border-line">
            {list.data.map((r) => (
              <li key={r.id} className="py-3 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium break-words">{r.title}</p>
                  <p className="text-[13px] text-muted">
                    {r.due_date ? `${formatDate(r.due_date)} · ` : ""}{formatDateTime(r.due_at)} ({r.timezone})
                    {r.late_by_seconds && r.late_by_seconds > 60 ? ` · delivered ${Math.round(r.late_by_seconds / 60)} min late` : ""}
                  </p>
                </div>
                <Badge tone={r.status === "scheduled" ? "accent" : r.status === "failed" ? "danger" : "neutral"}>{humanize(r.status)}</Badge>
                <Button size="sm" variant="ghost" className="whitespace-normal h-auto min-h-8 py-1 text-left" onClick={() => downloadFile(`reminders/${r.id}/calendar.ics`, `reminder-${r.id}.ics`).catch((e) => notify("error", (e as ApiError).message))}>
                  <Download aria-hidden className="size-3.5" />Download calendar file — this does not sync your calendar
                </Button>
                {r.status === "scheduled" ? <Button size="sm" variant="ghost" onClick={() => cancel(r)}><X aria-hidden className="size-3.5" />Cancel</Button> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
