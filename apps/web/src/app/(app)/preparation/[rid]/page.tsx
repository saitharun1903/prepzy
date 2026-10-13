"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { ExternalLink, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatDate, formatDateTime, humanize, todayISO } from "@/lib/format";
import type { RegenDiff, Roadmap, RoadmapTask } from "@/lib/types";
import {
  Badge, Button, DefinitionList, EmptyState, ErrorState, Field, Input, LoadingBlock, Notice, PageHeader, SectionTitle, Select, Textarea,
} from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

type TaskForm = { title: string; objective: string; low: string; high: string };

export default function RoadmapPage({ params }: { params: Promise<{ rid: string }> }) {
  const { rid } = use(params);
  const router = useRouter();
  const { notify } = useToast();
  const r = useApi<Roadmap>(`roadmaps/${rid}`);
  const [stale, setStale] = useState<string | null>(null);
  const [settings, setSettings] = useState<{ hours: string; target: string } | null>(null);
  const [editTask, setEditTask] = useState<{ t: RoadmapTask; f: TaskForm } | null>(null);
  const [newTask, setNewTask] = useState<TaskForm | null>(null);
  const [delTask, setDelTask] = useState<RoadmapTask | null>(null);
  const [delPlan, setDelPlan] = useState(false);
  const [preview, setPreview] = useState<RegenDiff | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<ApiError | null>(null);

  const run = async <T,>(name: string, fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    setBusy(name);
    setFormError(null);
    try {
      const out = await fn();
      if (ok) notify("ok", ok);
      return out;
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "stale_write") setStale(err.message);
      else { setFormError(err); notify("error", err.message); }
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (r.loading && !r.data) return <LoadingBlock rows={5} label="Loading plan" />;
  if (r.error && !r.data) return <ErrorState error={r.error} onRetry={r.reload} title="Could not load this plan" />;
  const d = r.data;
  if (!d) return null;

  const apply = (out: Roadmap | null) => { if (out) r.setData(out); return out; };
  const patchPlan = (body: Record<string, unknown>, ok: string) =>
    run("plan", () => apiFetch<Roadmap>(`roadmaps/${rid}`, { method: "PATCH", body: { expected_revision: d.revision, ...body } }), ok).then(apply);
  const patchTask = (t: RoadmapTask, body: Record<string, unknown>, ok: string) =>
    run(`task-${t.id}`, () => apiFetch<Roadmap>(`roadmaps/${rid}/tasks/${t.id}`, { method: "PATCH", body: { expected_version: t.version, ...body } }), ok).then(apply);

  const byKey = new Map(d.tasks.map((t) => [t.key, t]));
  const weeks = new Map<string, RoadmapTask[]>();
  for (const t of d.tasks) {
    const k = t.scheduled_week ? String(t.scheduled_week) : "none";
    weeks.set(k, [...(weeks.get(k) || []), t]);
  }
  const weekKeys = [...weeks.keys()].sort((a, b) => (a === "none" ? 1 : b === "none" ? -1 : Number(a) - Number(b)));
  const f = d.feasibility;

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/preparation" className="hover:underline underline-offset-4">Preparation</Link>}
        title={d.title}
        description={
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {d.generic ? <Badge tone="info">Generic starter plan</Badge> : null}
            <Badge tone={d.status === "active" ? "accent" : "neutral"}>{humanize(d.status)}</Badge>
            <span className="text-ink-2">{d.progress.done} of {d.progress.total} tasks done</span>
            {d.job_id ? <Link href={`/jobs/${d.job_id}?tab=match`} className="text-accent underline underline-offset-4">Open job comparison</Link> : null}
          </div>
        }
        actions={
          <>
            {d.status === "active" ? <Button size="sm" loading={busy === "plan"} onClick={() => patchPlan({ status: "paused" }, "Plan paused")}>Pause</Button> : null}
            {d.status !== "active" ? <Button size="sm" loading={busy === "plan"} onClick={() => patchPlan({ status: "active" }, "Plan resumed")}>Resume</Button> : null}
            <Button size="sm" loading={busy === "preview"} onClick={async () => {
              const p = await run("preview", () => apiFetch<RegenDiff>(`roadmaps/${rid}/regenerate/preview`, { method: "POST" }));
              if (p) setPreview(p);
            }}><RefreshCw aria-hidden className="size-4" />Regenerate</Button>
            <Button size="sm" variant="ghost" onClick={() => setDelPlan(true)}><Trash2 aria-hidden className="size-4" />Delete</Button>
          </>
        }
      />

      {stale ? (
        <Notice tone="warn" title="This plan changed elsewhere" className="mb-6" onDismiss={() => setStale(null)}>
          {stale} <Button size="sm" variant="link" onClick={() => { setStale(null); r.reload(); }}>Reload the plan</Button>
        </Notice>
      ) : null}

      <Notice tone="info" className="mb-8">Completing a task records your progress; it does not prove a skill. Add evidence (a project, course or work example) to your resume or profile for that.</Notice>

      <section aria-labelledby="feas-h" className="mb-10 grid gap-6 lg:grid-cols-[1fr_auto]">
        <div>
          <SectionTitle id="feas-h">Schedule</SectionTitle>
          <DefinitionList items={[
            { term: "Weekly hours", desc: `${d.weekly_hours} h` },
            { term: "Remaining effort", desc: `${f.total_hours_low}–${f.total_hours_high} h` },
            { term: "Weeks needed", desc: String(f.weeks_needed) },
            { term: "Estimated finish", desc: formatDate(f.estimated_finish) },
            { term: "Target date", desc: d.target_date ? `${formatDate(d.target_date)}${f.available_weeks !== undefined ? ` (${f.available_weeks} weeks available)` : ""}` : "None" },
          ]} />
          {f.feasible === false ? (
            <Notice tone="warn" className="mt-4" title="Doesn't fit before the target date">
              {f.suggestions?.length ? <ul className="list-disc pl-5">{f.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ul> : null}
            </Notice>
          ) : null}
        </div>
        <div><Button size="sm" onClick={() => setSettings({ hours: String(d.weekly_hours), target: d.target_date || "" })}>Change hours or date</Button></div>
      </section>

      <section aria-labelledby="tasks-h" className="mb-12">
        <SectionTitle id="tasks-h" actions={<Button size="sm" onClick={() => setNewTask({ title: "", objective: "", low: "2", high: "4" })}><Plus aria-hidden className="size-4" />Add task</Button>}>Tasks</SectionTitle>
        {!d.tasks.length ? <EmptyState title="No tasks">Add your own task or regenerate the plan.</EmptyState> : null}
        <div className="flex flex-col gap-8">
          {weekKeys.map((wk) => (
            <div key={wk}>
              <h3 className="text-sm font-semibold text-ink-2 mb-2">{wk === "none" ? "Not scheduled" : `Week ${wk}`}</h3>
              <ul className="flex flex-col gap-3">
                {weeks.get(wk)!.map((t) => (
                  <li key={t.id} className={`rounded-lg border border-line bg-surface p-4 ${t.status === "done" || t.status === "skipped" ? "opacity-75" : ""}`}>
                    <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className={`font-medium break-words ${t.status === "done" ? "line-through decoration-1" : ""}`}>{t.title}</p>
                        {t.objective ? <p className="text-sm text-ink-2 mt-1 prewrap">{t.objective}</p> : null}
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <Badge tone={t.priority === "high" ? "danger" : t.priority === "medium" ? "warn" : "neutral"}>{humanize(t.priority)} priority</Badge>
                          <Badge>{t.est_hours_low}–{t.est_hours_high} h</Badge>
                          {t.user_edited ? <Badge tone="info">Edited by you</Badge> : null}
                        </div>
                        {t.depends_on.length ? (
                          <p className="mt-2 text-[13px] text-muted">After: {t.depends_on.map((k) => byKey.get(k)?.title || k).join(", ")}</p>
                        ) : null}
                        <div className="mt-2 text-[13px]">
                          {t.resources.length ? (
                            <ul className="flex flex-col gap-1">
                              {t.resources.map((res, i) => (
                                <li key={i} className="flex flex-wrap items-center gap-1.5">
                                  {res.url ? (
                                    <a href={res.url} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-4 inline-flex items-center gap-1">
                                      {res.title}<ExternalLink aria-hidden className="size-3" /><span className="sr-only">(opens in a new tab)</span>
                                    </a>
                                  ) : <span>{res.title}</span>}
                                  <Badge tone={res.review_state === "reviewed" ? "ok" : "neutral"}>{humanize(res.review_state)}</Badge>
                                </li>
                              ))}
                            </ul>
                          ) : <span className="text-muted">Self-directed — no library resource linked.</span>}
                        </div>
                      </div>
                      <div className="flex sm:flex-col gap-2 sm:items-end shrink-0">
                        <label htmlFor={`st-${t.id}`} className="sr-only">Status of {t.title}</label>
                        <Select id={`st-${t.id}`} className="w-auto h-9" value={t.status} disabled={busy === `task-${t.id}`}
                          onChange={(e) => patchTask(t, { status: e.target.value }, `Marked ${humanize(e.target.value).toLowerCase()}`)}>
                          <option value="todo">To do</option>
                          <option value="in_progress">In progress</option>
                          <option value="done">Done</option>
                          <option value="skipped">Skipped</option>
                        </Select>
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" aria-label={`Edit ${t.title}`} onClick={() => setEditTask({ t, f: { title: t.title, objective: t.objective || "", low: String(t.est_hours_low), high: String(t.est_hours_high) } })}><Pencil aria-hidden className="size-3.5" /></Button>
                          <Button size="sm" variant="ghost" aria-label={`Delete ${t.title}`} onClick={() => setDelTask(t)}><Trash2 aria-hidden className="size-3.5" /></Button>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="hist-h">
        <SectionTitle id="hist-h">History</SectionTitle>
        {d.history.length ? (
          <ul className="flex flex-col gap-2 text-sm">
            {d.history.map((h, i) => (
              <li key={i} className="flex flex-wrap gap-x-3">
                <span className="text-muted w-44 shrink-0">{formatDateTime(h.at)}</span>
                <span className="font-medium">{humanize(h.kind)}</span>
                <span className="text-ink-2 break-all">{describe(h.detail)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted">No history.</p>}
        <p className="mt-3 text-[12px] text-muted">Planner {d.planner_version} · revision {d.revision}</p>
      </section>

      <Dialog open={Boolean(settings)} onClose={() => setSettings(null)} title="Change schedule" description="Tasks are rescheduled from today."
        footer={<>
          <Button onClick={() => setSettings(null)}>Cancel</Button>
          <Button variant="primary" loading={busy === "plan"} onClick={async () => {
            if (!settings) return;
            const body: Record<string, unknown> = { weekly_hours: Number(settings.hours) };
            if (settings.target) body.target_date = settings.target;
            else if (d.target_date) body.clear_target_date = true;
            if (await patchPlan(body, "Schedule updated")) setSettings(null);
          }}>Save</Button>
        </>}>
        {settings ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Weekly hours" error={formError?.fields?.weekly_hours}>{(p) => <Input id={p.id} type="number" min={1} max={60} value={settings.hours} data-autofocus onChange={(e) => setSettings({ ...settings, hours: e.target.value })} />}</Field>
            <Field label="Target date" hint="Leave empty for none." error={formError?.fields?.target_date}>{(p) => <Input id={p.id} type="date" min={todayISO()} value={settings.target} onChange={(e) => setSettings({ ...settings, target: e.target.value })} aria-describedby={p.describedBy} />}</Field>
          </div>
        ) : null}
      </Dialog>

      <Dialog open={Boolean(editTask || newTask)} onClose={() => { setEditTask(null); setNewTask(null); }}
        title={editTask ? "Edit task" : "Add a custom task"}
        description={editTask ? "Edited tasks are kept when the plan is regenerated." : "Custom tasks are scheduled with the rest of the plan."}
        footer={<>
          <Button onClick={() => { setEditTask(null); setNewTask(null); }}>Cancel</Button>
          <Button variant="primary" loading={busy !== null} onClick={async () => {
            const form = editTask?.f || newTask;
            if (!form) return;
            const body = { title: form.title.trim(), objective: form.objective.trim() || null, est_hours_low: Number(form.low), est_hours_high: Number(form.high) };
            if (editTask) { if (await patchTask(editTask.t, body, "Task updated")) setEditTask(null); }
            else {
              const out = await run("add", () => apiFetch<Roadmap>(`roadmaps/${rid}/tasks`, { method: "POST", body }), "Task added");
              if (apply(out)) setNewTask(null);
            }
          }}>Save</Button>
        </>}>
        {(() => {
          const form = editTask?.f || newTask;
          if (!form) return null;
          const set = (patch: Partial<TaskForm>) => editTask ? setEditTask({ ...editTask, f: { ...editTask.f, ...patch } }) : setNewTask({ ...form, ...patch });
          return (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Title" className="sm:col-span-2" error={formError?.fields?.title}>{(p) => <Input id={p.id} value={form.title} maxLength={300} data-autofocus onChange={(e) => set({ title: e.target.value })} />}</Field>
              <Field label="Objective (optional)" className="sm:col-span-2">{(p) => <Textarea id={p.id} rows={3} maxLength={4000} value={form.objective} onChange={(e) => set({ objective: e.target.value })} />}</Field>
              <Field label="Estimate low (hours)" error={formError?.fields?.est_hours_low}>{(p) => <Input id={p.id} type="number" min={0.5} step={0.5} value={form.low} onChange={(e) => set({ low: e.target.value })} />}</Field>
              <Field label="Estimate high (hours)" error={formError?.fields?.est_hours_high}>{(p) => <Input id={p.id} type="number" min={0.5} step={0.5} value={form.high} onChange={(e) => set({ high: e.target.value })} />}</Field>
            </div>
          );
        })()}
      </Dialog>

      <Dialog open={Boolean(delTask)} onClose={() => setDelTask(null)} title="Delete this task?" description={delTask?.title}
        footer={<><Button onClick={() => setDelTask(null)}>Cancel</Button><Button variant="danger" loading={busy === "deltask"} onClick={async () => {
          if (!delTask) return;
          apply(await run("deltask", () => apiFetch<Roadmap>(`roadmaps/${rid}/tasks/${delTask.id}`, { method: "DELETE" }), "Task deleted"));
          setDelTask(null);
        }}>Delete task</Button></>}>
        <p className="text-sm text-ink-2">The remaining tasks are rescheduled. A regenerated plan may add it back if it is still a gap.</p>
      </Dialog>

      <Dialog open={delPlan} onClose={() => setDelPlan(false)} title="Delete this plan?" description="All its tasks and history are permanently deleted."
        footer={<><Button onClick={() => setDelPlan(false)}>Cancel</Button><Button variant="danger" loading={busy === "delplan"} onClick={async () => {
          const ok = await run("delplan", async () => { await apiFetch(`roadmaps/${rid}`, { method: "DELETE" }); return true; }, "Plan deleted");
          if (ok) router.replace("/preparation");
          setDelPlan(false);
        }}>Delete plan</Button></>} />

      <Dialog open={Boolean(preview)} onClose={() => setPreview(null)} size="lg" title="Regenerate plan — preview"
        description="Nothing changes until you apply. Completed, in-progress, skipped and edited tasks are kept."
        footer={<>
          <Button onClick={() => setPreview(null)}>Cancel</Button>
          <Button variant="primary" loading={busy === "apply"} disabled={!preview || (!preview.diff.add.length && !preview.diff.remove.length && !preview.diff.update.length)}
            onClick={async () => {
              if (!preview) return;
              const out = await run("apply", () => apiFetch<Roadmap>(`roadmaps/${rid}/regenerate/apply`, { method: "POST", body: { expected_revision: preview.based_on_revision } }), "Plan regenerated");
              if (apply(out)) setPreview(null);
            }}>Apply changes</Button>
        </>}>
        {preview ? (
          <div className="flex flex-col gap-5 text-sm">
            {([
              ["Add", preview.diff.add.map((x) => `${x.title} (${x.priority} priority)`), "ok"],
              ["Remove", preview.diff.remove.map((x) => x.title), "danger"],
              ["Update", preview.diff.update.map((x) => `${x.title}: priority → ${String(x.changes.priority ?? "")}`), "warn"],
              ["Keep", preview.diff.keep.map((x) => `${x.title} — ${x.reason}`), "neutral"],
            ] as const).map(([label, items, tone]) => (
              <div key={label}>
                <p className="font-medium mb-1 flex items-center gap-2">{label} <Badge tone={tone}>{items.length}</Badge></p>
                {items.length ? <ul className="list-disc pl-5 text-ink-2 flex flex-col gap-0.5">{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="text-muted">None</p>}
              </div>
            ))}
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

function describe(detail: Record<string, unknown>): string {
  return Object.entries(detail || {})
    .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${humanize(k)}: ${Array.isArray(v) ? v.join(" → ") : typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}
