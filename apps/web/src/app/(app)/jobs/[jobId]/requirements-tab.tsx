"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2, Undo2, X } from "lucide-react";
import { ApiError } from "@/lib/api";
import { humanize } from "@/lib/format";
import type { JobDetail, Requirement, SkillHit } from "@/lib/types";
import { SkillPicker } from "@/components/skill-picker";
import { Badge, Button, EmptyState, ErrorState, Field, Notice, SectionTitle, Select, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { CATEGORIES, IMPORTANCES, addCorrection, revertCorrection } from "./shared";

function groupText(r: Requirement): string | null {
  if (r.concepts.length < 2) return null;
  const labels = r.concepts.map((c) => c.label);
  if (r.group === "any") return `Any one of: ${labels.join(" OR ")}`;
  if (r.group === "all") return `All of: ${labels.join(" AND ")}`;
  return null;
}

function RequirementItem({ r, editable, onEdit, onRemove, onRevert }: {
  r: Requirement; editable: boolean; onEdit: () => void; onRemove: () => void; onRevert: () => void;
}) {
  const g = groupText(r);
  const corrected = r.review === "corrected";
  const added = r.review === "user_added";
  return (
    <li className={`py-4 ${corrected || added ? "border-l-2 border-info pl-3 -ml-3" : ""}`}>
      <p className="text-[15px] text-ink break-words">&ldquo;{r.text}&rdquo;</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge>{humanize(r.category)}</Badge>
        {added ? <Badge tone="info">Added by you</Badge> : null}
        {corrected && !r.removed_by_user ? <Badge tone="info">Corrected by you</Badge> : null}
        {r.negated ? <Badge tone="warn">Stated as not required</Badge> : null}
        {r.years ? (
          <Badge tone={r.years.ambiguous ? "warn" : "neutral"}>
            {r.years.ambiguous ? `Ambiguous threshold: "${r.years.original}"` : `${r.years.min}${r.years.max ? `–${r.years.max}` : "+"} years`}
          </Badge>
        ) : null}
        {r.method === "rules" ? <Badge tone="warn">Keyword scan only</Badge> : null}
      </div>
      {g ? <p className="mt-2 text-sm text-ink-2"><span className="font-medium">{g}</span></p> : null}
      {r.concepts.length ? (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Concepts">
          {r.concepts.map((c) => <li key={c.id}><Badge tone="accent">{c.label}</Badge></li>)}
        </ul>
      ) : null}
      {r.notes.length ? (
        <ul className="mt-2 text-[13px] text-muted list-disc pl-5">{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      ) : null}
      {r.original ? (
        <p className="mt-2 text-[13px] text-muted">
          Originally: {humanize(r.original.importance)} · {humanize(r.original.category)} · group {r.original.group}
        </p>
      ) : null}
      {editable ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {!r.removed_by_user && !added ? (
            <>
              <Button size="sm" variant="ghost" onClick={onEdit}><Pencil aria-hidden className="size-3.5" />Edit</Button>
              <Button size="sm" variant="ghost" onClick={onRemove}><Trash2 aria-hidden className="size-3.5" />Remove</Button>
            </>
          ) : null}
          {r.correction_id ? (
            <Button size="sm" variant="ghost" onClick={onRevert}>
              {added ? <><X aria-hidden className="size-3.5" />Delete my requirement</> : <><Undo2 aria-hidden className="size-3.5" />Revert to original</>}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function RequirementsTab({ detail, reload }: { detail: JobDetail; reload: () => void }) {
  const { notify } = useToast();
  const a = detail.analysis;
  const [edit, setEdit] = useState<Requirement | null>(null);
  const [form, setForm] = useState({ importance: "required", category: "skill", group: "single" });
  const [adding, setAdding] = useState(false);
  const [newReq, setNewReq] = useState({ text: "", importance: "required", category: "skill" });
  const [newSkills, setNewSkills] = useState<SkillHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  if (!a) return <EmptyState title="No analysis yet">Requirements appear after the job has been analysed.</EmptyState>;
  const editable = a.is_latest;
  const reqs = a.result.requirements;

  const correct = async (r: Requirement, value: Record<string, unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      await addCorrection(detail.job.id, { analysis_id: a.id, target: "requirement", key: r.key, value });
      notify("ok", ok);
      setEdit(null);
      reload();
    } catch (e) {
      setError(e as ApiError);
      notify("error", (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const revert = async (r: Requirement) => {
    if (!r.correction_id) return;
    try {
      await revertCorrection(detail.job.id, r.correction_id);
      notify("ok", "Reverted");
      reload();
    } catch (e) {
      notify("error", (e as ApiError).message);
    }
  };

  const addNew = async () => {
    setBusy(true);
    setError(null);
    try {
      const ids = newSkills.map((s) => s.id);
      await addCorrection(detail.job.id, {
        analysis_id: a.id, target: "requirement_new", key: "new",
        value: { text: newReq.text.trim(), importance: newReq.importance, category: newReq.category, concept_ids: ids },
      });
      notify("ok", "Requirement added");
      setAdding(false);
      setNewReq({ text: "", importance: "required", category: "skill" });
      setNewSkills([]);
      reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const live = reqs.filter((r) => !r.removed_by_user);
  const groups: { id: string; title: string; items: Requirement[] }[] = [
    { id: "required", title: "Required", items: live.filter((r) => r.importance === "required") },
    { id: "preferred", title: "Preferred", items: live.filter((r) => r.importance === "preferred" || r.importance === "optional") },
    { id: "unclear", title: "Unclear importance", items: live.filter((r) => r.importance === "unclear") },
  ];
  const removed = reqs.filter((r) => r.removed_by_user);

  const itemProps = (r: Requirement) => ({
    r, editable,
    onEdit: () => { setEdit(r); setForm({ importance: r.importance, category: r.category, group: r.group }); setError(null); },
    onRemove: () => correct(r, { importance: r.importance, category: r.category, group: r.group, removed: true }, "Requirement removed from matching"),
    onRevert: () => revert(r),
  });

  return (
    <div className="flex flex-col gap-10">
      <Notice tone="info">
        Each requirement quotes the posting&apos;s own wording. Your corrections are stored separately and the original stays visible.
        {!editable ? " You are viewing an older analysis; switch to the latest to make corrections." : ""}
      </Notice>
      {editable ? (
        <div><Button onClick={() => { setAdding(true); setError(null); }}><Plus aria-hidden className="size-4" />Add a requirement</Button></div>
      ) : null}
      {!reqs.length ? <EmptyState title="No requirements identified">You can add requirements the analysis missed.</EmptyState> : null}

      {groups.map((g) => g.items.length ? (
        <section key={g.id} aria-labelledby={`req-${g.id}`}>
          <SectionTitle id={`req-${g.id}`}>{g.title} ({g.items.length})</SectionTitle>
          <ul className="divide-y divide-line border-y border-line">
            {g.items.map((r) => <RequirementItem key={r.key} {...itemProps(r)} />)}
          </ul>
        </section>
      ) : null)}

      {removed.length ? (
        <section aria-labelledby="req-removed">
          <SectionTitle id="req-removed">Removed by you ({removed.length})</SectionTitle>
          <p className="text-[13px] text-muted mb-2">Not used for matching. Revert to restore.</p>
          <ul className="divide-y divide-line border-y border-line opacity-80">
            {removed.map((r) => <RequirementItem key={r.key} {...itemProps(r)} />)}
          </ul>
        </section>
      ) : null}

      <Dialog open={Boolean(edit)} onClose={() => setEdit(null)} title="Edit requirement"
        description={edit ? <>&ldquo;{edit.text}&rdquo;</> : undefined}
        footer={<><Button onClick={() => setEdit(null)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => edit && correct(edit, form, "Requirement corrected")}>Save correction</Button></>}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Importance">
            {(p) => <Select id={p.id} value={form.importance} onChange={(e) => setForm({ ...form, importance: e.target.value })} data-autofocus>
              {IMPORTANCES.map((i) => <option key={i} value={i}>{humanize(i)}</option>)}</Select>}
          </Field>
          <Field label="Category">
            {(p) => <Select id={p.id} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((i) => <option key={i} value={i}>{humanize(i)}</option>)}</Select>}
          </Field>
          <Field label="Concept group" hint="How listed skills combine.">
            {(p) => <Select id={p.id} value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} aria-describedby={p.describedBy}>
              <option value="single">Single</option>
              <option value="any">Any of (alternatives)</option>
              <option value="all">All of</option>
            </Select>}
          </Field>
        </div>
        {error ? <div className="mt-3"><ErrorState error={error} title="Could not save" /></div> : null}
      </Dialog>

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add a requirement"
        description="Use this for a requirement the analysis missed. It is labelled as added by you."
        footer={<><Button onClick={() => setAdding(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={newReq.text.trim().length < 3} onClick={addNew}>Add requirement</Button></>}>
        <div className="flex flex-col gap-4">
          <Field label="Requirement wording" required error={error?.fields?.["value.text"]}>
            {(p) => <Textarea id={p.id} rows={3} maxLength={600} value={newReq.text} onChange={(e) => setNewReq({ ...newReq, text: e.target.value })} data-autofocus aria-invalid={p.invalid} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Importance">
              {(p) => <Select id={p.id} value={newReq.importance} onChange={(e) => setNewReq({ ...newReq, importance: e.target.value })}>
                {IMPORTANCES.map((i) => <option key={i} value={i}>{humanize(i)}</option>)}</Select>}
            </Field>
            <Field label="Category">
              {(p) => <Select id={p.id} value={newReq.category} onChange={(e) => setNewReq({ ...newReq, category: e.target.value })}>
                {CATEGORIES.map((i) => <option key={i} value={i}>{humanize(i)}</option>)}</Select>}
            </Field>
          </div>
          <SkillPicker label="Skills this requirement asks for (optional)" exclude={newSkills.map((s) => s.id)}
            onPick={(s) => setNewSkills((xs) => [...xs, s])} hint="Linking skills lets matching check your evidence." />
          {newSkills.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {newSkills.map((s) => (
                <li key={s.id} className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-0.5 text-[13px]">
                  {s.label}
                  <button type="button" aria-label={`Remove ${s.label}`} onClick={() => setNewSkills((xs) => xs.filter((x) => x.id !== s.id))}><X aria-hidden className="size-3.5" /></button>
                </li>
              ))}
            </ul>
          ) : null}
          {error && !error.fields?.["value.text"] ? <ErrorState error={error} title="Could not add" /> : null}
        </div>
      </Dialog>
    </div>
  );
}
