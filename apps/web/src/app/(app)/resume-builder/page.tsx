"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FileCode2, Sparkles, Trash2, Type } from "lucide-react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { relativeTime } from "@/lib/format";
import type { Accepted } from "@/lib/types";
import { SAMPLE_RESUME, latexTemplate, toLatex, type TailorResult, type TailoredResume } from "@/lib/resume-templates";
import { ResumeVersionSelect, type VersionPick } from "@/components/resume-version-select";
import { OperationStatus } from "@/components/operation-status";
import { TemplateGallery } from "@/components/resume/template-gallery";
import { Dialog } from "@/components/ui/dialog";
import { Button, EmptyState, ErrorState, LoadingBlock, PageHeader, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";

type DocSummary = { id: string; title: string; template: string; version: number; updated_at: string; job_id: string | null; has_data: boolean };

export default function ResumeBuilderPage() {
  const router = useRouter();
  const { notify } = useToast();
  const docs = useApi<{ items: DocSummary[] }>("latex/docs");
  const [fill, setFill] = useState<"sample" | "mine">("sample");
  const [pick, setPick] = useState<VersionPick>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const [del, setDel] = useState<DocSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const createDoc = async (templateId: string, data: TailoredResume, title: string) => {
    const d = await apiFetch<{ id: string }>("latex/docs", {
      method: "POST", body: { title, template: templateId, data, source: toLatex(data, templateId) },
    });
    router.push(`/resume-builder/${d.id}`);
  };

  const start = async (templateId: string) => {
    setCreating(templateId);
    try {
      if (fill === "sample") {
        await createDoc(templateId, SAMPLE_RESUME, `My resume (${latexTemplate(templateId).label})`);
        return;
      }
      if (!pick?.versionId) { notify("error", "Upload your resume first (My resume), or choose Sample text."); setCreating(null); return; }
      const r = await apiFetch<Accepted>(`resumes/${pick.resumeId}/versions/${pick.versionId}/tailored`, {
        method: "POST", body: { template: templateId }, idempotencyKey: newIdempotencyKey(),
      });
      setOpId(r.operation_id);
    } catch (e) {
      notify("error", (e as ApiError).message);
      setCreating(null);
    }
  };

  const remove = async () => {
    if (!del) return;
    setBusy(true);
    try {
      await apiFetch(`latex/docs/${del.id}`, { method: "DELETE" });
      setDel(null);
      docs.reload();
    } catch (e) {
      notify("error", (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Resume builder" description="Professional LaTeX resumes with live preview — fill a form or edit the code, like Overleaf." />

      <section aria-labelledby="tpl-h" className="mb-12">
        <h2 id="tpl-h" className="serif text-2xl">Start a new resume</h2>

        <div className="mt-3 mb-5 rounded-2xl border border-line bg-surface p-4">
          <p className="text-sm font-medium text-ink mb-2">Fill it with</p>
          <div role="radiogroup" aria-label="Fill the template with" className="flex flex-wrap gap-2">
            {([["sample", Type, "Sample text", "Replace it with your own details"], ["mine", Sparkles, "My uploaded resume", "AI copies your real details — nothing invented"]] as const).map(([id, Icon, t, d]) => (
              <button key={id} type="button" role="radio" aria-checked={fill === id} onClick={() => setFill(id)}
                className={cx("flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-left transition min-w-[15rem]", fill === id ? "border-accent bg-accent-soft" : "border-line hover:border-accent/40")}>
                <Icon aria-hidden className="size-4.5 mt-0.5 text-accent shrink-0" />
                <span><span className="block font-medium text-ink text-sm">{t}</span><span className="block text-[12.5px] text-ink-2">{d}</span></span>
              </button>
            ))}
          </div>
          {fill === "mine" ? <div className="mt-3 max-w-xl"><ResumeVersionSelect value={pick} onChange={setPick} label="Use this resume" autoSelect /></div> : null}
          {opId ? (
            <div className="mt-3">
              <OperationStatus<TailorResult> opId={opId} label="Reading your resume" onDone={async (op) => {
                setOpId(null);
                if (op.result && "resume" in op.result && creating) {
                  try { await createDoc(creating, op.result.resume, `${op.result.resume.name || "My"} resume (${latexTemplate(creating).label})`); }
                  catch (e) { notify("error", (e as ApiError).message); setCreating(null); }
                } else setCreating(null);
              }} />
            </div>
          ) : null}
        </div>

        <p className="text-sm text-ink-2 mb-3">Pick a template — you can switch to any other one later without losing your content.</p>
        <TemplateGallery onPick={start} busyId={creating} />
      </section>

      <section aria-labelledby="docs-h">
        <h2 id="docs-h" className="serif text-2xl mb-3">Your resumes</h2>
        {docs.loading && !docs.data ? <LoadingBlock rows={3} /> : null}
        {docs.error ? <ErrorState error={docs.error} onRetry={docs.reload} title="Couldn't load your resumes" /> : null}
        {docs.data && !docs.data.items.length ? <EmptyState title="No resumes yet">Pick a template above to start.</EmptyState> : null}
        {docs.data?.items.length ? (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {docs.data.items.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {d.template !== "custom" ? <img src={`/templates/${latexTemplate(d.template).id}.png`} alt="" className="h-12 w-9 rounded object-cover object-top ring-1 ring-black/10 shrink-0" />
                  : <span className="grid place-items-center h-12 w-9 rounded bg-accent-soft text-accent shrink-0"><FileCode2 aria-hidden className="size-4" /></span>}
                <div className="min-w-0 flex-1">
                  <Link href={`/resume-builder/${d.id}`} className="font-medium text-ink hover:underline underline-offset-4 break-words">{d.title}</Link>
                  <p className="text-[13px] text-muted">{d.template === "custom" ? "Custom LaTeX" : latexTemplate(d.template).label} · edited {relativeTime(d.updated_at)}</p>
                </div>
                <Link href={`/resume-builder/${d.id}`} className="text-sm font-medium text-accent hover:underline underline-offset-4">Open</Link>
                <button type="button" onClick={() => setDel(d)} aria-label={`Delete ${d.title}`}
                  className="p-2 rounded-lg text-muted hover:text-danger hover:bg-danger-soft"><Trash2 aria-hidden className="size-4" /></button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <Dialog open={Boolean(del)} onClose={() => setDel(null)} title="Delete this resume?" description={del ? `"${del.title}" will be permanently deleted.` : undefined}
        footer={<><Button variant="ghost" onClick={() => setDel(null)}>Cancel</Button><Button variant="danger" loading={busy} onClick={remove}>Delete</Button></>} />
    </>
  );
}
