"use client";

import { useState, type FormEvent } from "react";
import { ExternalLink, Trash2, X } from "lucide-react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatDate, formatDateTime, humanize } from "@/lib/format";
import type { Domain, KnowledgeSource, SkillHit } from "@/lib/types";
import { useSession } from "@/components/shell/session";
import { SkillPicker } from "@/components/skill-picker";
import { OperationStatus } from "@/components/operation-status";
import {
  Badge, Button, EmptyState, ErrorState, Field, Input, LoadingBlock, Notice, PageHeader, SectionTitle, Select, Textarea,
} from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

type Ingest = { source_id: string; version_id: string; operation_id: string | null; unchanged: boolean };

export default function AdminKnowledgePage() {
  const { me } = useSession();
  if (!me) return <LoadingBlock rows={3} />;
  if (!me.user.is_admin) {
    return (
      <>
        <PageHeader title="Knowledge library" />
        <Notice tone="warn" title="Administrators only">Your account does not have access to the shared knowledge library.</Notice>
      </>
    );
  }
  return <Admin />;
}

function Admin() {
  const { notify } = useToast();
  const list = useApi<KnowledgeSource[]>("admin/knowledge");
  const domains = useApi<{ domains: Domain[] }>("taxonomy/domains");
  const [form, setForm] = useState({ title: "", text: "", source_url: "", domain: "", license_basis: "", published_on: "" });
  const [skills, setSkills] = useState<SkillHit[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [ops, setOps] = useState<{ id: string; label: string }[]>([]);
  const [review, setReview] = useState<{ s: KnowledgeSource; state: string; note: string } | null>(null);
  const [reingest, setReingest] = useState<{ s: KnowledgeSource; text: string } | null>(null);
  const [del, setDel] = useState<KnowledgeSource | null>(null);

  const track = (out: Ingest, label: string) => {
    if (out.operation_id) setOps((xs) => [{ id: out.operation_id!, label }, ...xs]);
    else if (out.unchanged) notify("info", "Identical text is already active or being ingested");
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("create");
    setError(null);
    try {
      const out = await apiFetch<Ingest>("admin/knowledge", {
        method: "POST", idempotencyKey: newIdempotencyKey(),
        body: {
          title: form.title.trim(), text: form.text, source_url: form.source_url.trim() || null, domain: form.domain || null,
          skills: skills.map((s) => s.id), license_basis: form.license_basis.trim(), published_on: form.published_on || null,
          source_type: form.source_url.trim() ? "url_supplied" : "authored",
        },
      });
      track(out, `Ingesting “${form.title.trim()}”`);
      setForm({ title: "", text: "", source_url: "", domain: "", license_basis: "", published_on: "" });
      setSkills([]);
      list.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  };

  const doReview = async () => {
    if (!review) return;
    setBusy("review");
    try {
      await apiFetch(`admin/knowledge/${review.s.id}/review`, { method: "POST", body: { review_state: review.state, review_note: review.note.trim() } });
      notify("ok", "Review recorded");
      setReview(null);
      list.reload();
    } catch (e) {
      notify("error", (e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  const doReingest = async () => {
    if (!reingest) return;
    setBusy("reingest");
    try {
      const out = await apiFetch<Ingest>(`admin/knowledge/${reingest.s.id}/versions`, { method: "POST", body: { text: reingest.text } });
      track(out, `Re-ingesting “${reingest.s.title}”`);
      setReingest(null);
      list.reload();
    } catch (e) {
      notify("error", (e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  const f = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <PageHeader eyebrow="Admin" title="Shared knowledge library" description="Sources used for cited answers and plan resources. Every source needs a licence basis, and review records what was actually checked." />

      {ops.length ? <div className="flex flex-col gap-2 mb-8">{ops.map((o) => <OperationStatus key={o.id} opId={o.id} label={o.label} onDone={() => list.reload()} />)}</div> : null}

      <section aria-labelledby="create-h" className="mb-12">
        <SectionTitle id="create-h">Add a source</SectionTitle>
        <form onSubmit={create} className="grid gap-4 sm:grid-cols-2 max-w-3xl" noValidate>
          <Field label="Title" required className="sm:col-span-2" error={error?.fields?.title}>{(p) => <Input id={p.id} value={form.title} maxLength={300} onChange={f("title")} aria-invalid={p.invalid} />}</Field>
          <Field label="Text" required className="sm:col-span-2" hint="At least 200 characters. Plain text." error={error?.fields?.text}>
            {(p) => <Textarea id={p.id} rows={10} value={form.text} onChange={f("text")} aria-describedby={p.describedBy} aria-invalid={p.invalid} />}
          </Field>
          <Field label="Licence basis" required className="sm:col-span-2" hint="Why Prepzy may use this text: licence, permission, or your own work." error={error?.fields?.license_basis}>
            {(p) => <Textarea id={p.id} rows={2} maxLength={1000} value={form.license_basis} onChange={f("license_basis")} aria-describedby={p.describedBy} aria-invalid={p.invalid} />}
          </Field>
          <Field label="Source URL (optional)" error={error?.fields?.source_url}>{(p) => <Input id={p.id} type="url" value={form.source_url} onChange={f("source_url")} aria-invalid={p.invalid} />}</Field>
          <Field label="Published on (optional)">{(p) => <Input id={p.id} type="date" value={form.published_on} onChange={f("published_on")} />}</Field>
          <Field label="Domain (optional)" error={error?.fields?.domain}>
            {(p) => <Select id={p.id} value={form.domain} onChange={f("domain")}>
              <option value="">None</option>
              {domains.data?.domains.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </Select>}
          </Field>
          <div className="sm:col-span-2">
            <SkillPicker label="Skills covered (optional)" exclude={skills.map((s) => s.id)} onPick={(s) => setSkills((xs) => xs.length < 30 ? [...xs, s] : xs)} />
            {skills.length ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {skills.map((s) => (
                  <li key={s.id} className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-0.5 text-[13px]">
                    {s.label}<button type="button" aria-label={`Remove ${s.label}`} onClick={() => setSkills((xs) => xs.filter((x) => x.id !== s.id))}><X aria-hidden className="size-3.5" /></button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {error ? <div className="sm:col-span-2"><ErrorState error={error} title="Could not add the source" /></div> : null}
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary" loading={busy === "create"} disabled={form.title.trim().length < 3 || form.text.length < 200 || form.license_basis.trim().length < 5}>Add and ingest</Button>
          </div>
        </form>
      </section>

      <section aria-labelledby="src-h">
        <SectionTitle id="src-h">Sources</SectionTitle>
        {list.loading && !list.data ? <LoadingBlock rows={3} /> : null}
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.data && !list.data.length ? <EmptyState title="No shared sources yet" /> : null}
        <ul className="flex flex-col gap-4">
          {list.data?.map((s) => (
            <li key={s.id} className="rounded-lg border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium break-words">{s.title}</span>
                <Badge tone={s.review_state === "reviewed" ? "ok" : s.review_state === "rejected" ? "danger" : "neutral"}>{humanize(s.review_state)}</Badge>
                {s.domain ? <Badge>{s.domain}</Badge> : null}
                {s.active_version_id ? <Badge tone="accent">Active</Badge> : <Badge tone="warn">No active version</Badge>}
              </div>
              <p className="text-[13px] text-muted mt-1 break-words">Licence: {s.license_basis}</p>
              {s.review_note ? <p className="text-[13px] text-ink-2 mt-1">Review note: {s.review_note}</p> : null}
              {s.source_url ? <a href={s.source_url} target="_blank" rel="noopener noreferrer nofollow" className="text-[13px] text-accent underline underline-offset-4 inline-flex items-center gap-1">Source<ExternalLink aria-hidden className="size-3" /><span className="sr-only">(opens in a new tab)</span></a> : null}
              <p className="text-[12px] text-muted mt-1">Added {formatDate(s.created_at)}{s.published_on ? ` · published ${formatDate(s.published_on)}` : ""}{s.skills.length ? ` · ${s.skills.length} skills` : ""}</p>
              {s.versions?.length ? (
                <ul className="mt-3 text-[13px] flex flex-col gap-1">
                  {s.versions.map((v) => (
                    <li key={v.id} className="flex flex-wrap gap-x-3">
                      <span>v{v.version}</span>
                      <span className={v.status === "failed" ? "text-danger" : v.status === "active" ? "text-ok" : "text-ink-2"}>{humanize(v.status)}</span>
                      {v.chunk_count !== null ? <span className="text-muted">{v.chunk_count} passages</span> : null}
                      <span className="text-muted">{v.embed_model}</span>
                      {v.activated_at ? <span className="text-muted">activated {formatDateTime(v.activated_at)}</span> : null}
                      {v.error ? <span className="text-danger">{v.error}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-1">
                <Button size="sm" onClick={() => setReview({ s, state: s.review_state === "unreviewed" ? "reviewed" : s.review_state, note: "" })}>Review</Button>
                <Button size="sm" variant="ghost" onClick={() => setReingest({ s, text: "" })}>Re-ingest new text</Button>
                <Button size="sm" variant="ghost" onClick={() => setDel(s)}><Trash2 aria-hidden className="size-3.5" />Delete</Button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <Dialog open={Boolean(review)} onClose={() => setReview(null)} title="Record a review" description={review?.s.title}
        footer={<><Button onClick={() => setReview(null)}>Cancel</Button><Button variant="primary" loading={busy === "review"} disabled={!review || review.note.trim().length < 3} onClick={doReview}>Save review</Button></>}>
        {review ? (
          <div className="flex flex-col gap-4">
            <Field label="State">{(p) => <Select id={p.id} value={review.state} onChange={(e) => setReview({ ...review, state: e.target.value })} data-autofocus>
              <option value="unreviewed">Unreviewed</option><option value="reviewed">Reviewed</option><option value="rejected">Rejected</option>
            </Select>}</Field>
            <Field label="What did you check?" hint="Be specific, e.g. 'Checked SQL join examples against PostgreSQL 16 docs'.">
              {(p) => <Textarea id={p.id} rows={3} maxLength={2000} value={review.note} onChange={(e) => setReview({ ...review, note: e.target.value })} aria-describedby={p.describedBy} />}
            </Field>
          </div>
        ) : null}
      </Dialog>

      <Dialog open={Boolean(reingest)} onClose={() => setReingest(null)} title="Ingest a new version" description="The current version stays active until the new one finishes ingesting."
        footer={<><Button onClick={() => setReingest(null)}>Cancel</Button><Button variant="primary" loading={busy === "reingest"} disabled={!reingest || reingest.text.length < 200} onClick={doReingest}>Ingest</Button></>}>
        {reingest ? <Field label="New text" hint="At least 200 characters.">{(p) => <Textarea id={p.id} rows={10} value={reingest.text} onChange={(e) => setReingest({ ...reingest, text: e.target.value })} data-autofocus aria-describedby={p.describedBy} />}</Field> : null}
      </Dialog>

      <Dialog open={Boolean(del)} onClose={() => setDel(null)} title="Delete this source?" description={del?.title}
        footer={<><Button onClick={() => setDel(null)}>Cancel</Button><Button variant="danger" onClick={async () => {
          if (!del) return;
          try {
            await apiFetch(`admin/knowledge/${del.id}`, { method: "DELETE" });
            notify("ok", "Source deleted");
            list.reload();
          } catch (e) {
            notify("error", (e as ApiError).message);
          }
          setDel(null);
        }}>Delete source</Button></>}>
        <p className="text-sm text-ink-2">Its passages are removed from search immediately. Existing plan tasks keep the title and link they stored.</p>
      </Dialog>
    </>
  );
}
