"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Code2, FileCode2, FileUp, Sparkles, Trash2, Type } from "lucide-react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { relativeTime } from "@/lib/format";
import type { Accepted } from "@/lib/types";
import { SAMPLE_RESUME, latexTemplate, toLatex, type TailorResult, type TailoredResume } from "@/lib/resume-templates";
import { ResumeVersionSelect, type VersionPick } from "@/components/resume-version-select";
import { OperationStatus } from "@/components/operation-status";
import { TemplateGallery } from "@/components/resume/template-gallery";
import { Dialog } from "@/components/ui/dialog";
import { Button, EmptyState, ErrorState, Input, LoadingBlock, PageHeader, Textarea, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";

type DocSummary = { id: string; title: string; template: string; version: number; updated_at: string; job_id: string | null; has_data: boolean };

export default function ResumeBuilderPage() {
  const router = useRouter();
  const { notify } = useToast();
  const docs = useApi<{ items: DocSummary[] }>("latex/docs");
  const [fill, setFill] = useState<"sample" | "mine" | "code">("sample");
  const [code, setCode] = useState("");
  const [codeTitle, setCodeTitle] = useState("");
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

  const createFromCode = async () => {
    setCreating("custom");
    try {
      const d = await apiFetch<{ id: string }>("latex/docs", { method: "POST", body: { title: codeTitle.trim() || "My LaTeX resume", template: "custom", source: code } });
      router.push(`/resume-builder/${d.id}`);
    } catch (e) {
      notify("error", (e as ApiError).message);
      setCreating(null);
    }
  };

  const loadTex = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 200_000) { notify("error", "That file is too large for a resume (max 200 KB)."); return; }
    setCode(await f.text());
    if (!codeTitle) setCodeTitle(f.name.replace(/\.tex$/i, "").slice(0, 120));
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
      <PageHeader title="Resume builder" description="Professional LaTeX resumes with a live PDF preview — like Overleaf, made simple." />

      <section aria-labelledby="tpl-h" className="mb-12">
        <h2 id="tpl-h" className="serif text-2xl">Start a new resume</h2>
        <div role="radiogroup" aria-label="How do you want to start?" className="mt-3 grid gap-3 sm:grid-cols-3">
          {([
            ["sample", Type, "Pick a template", "Start with sample text and replace it"],
            ["mine", Sparkles, "Use my uploaded resume", "Your real details in any template"],
            ["code", Code2, "Paste my LaTeX code", "Already have a .tex? Edit it here"],
          ] as const).map(([id, Icon, t, d]) => (
            <button key={id} type="button" role="radio" aria-checked={fill === id} onClick={() => setFill(id)}
              className={cx("flex items-start gap-3 rounded-2xl border p-4 text-left transition bg-surface",
                fill === id ? "border-accent ring-2 ring-accent/20" : "border-line hover:border-accent/40")}>
              <span className={cx("grid place-items-center size-9 rounded-xl shrink-0", fill === id ? "bg-accent text-white" : "bg-accent-soft text-accent")}><Icon aria-hidden className="size-4.5" /></span>
              <span><span className="block font-semibold text-ink">{t}</span><span className="block text-[13px] text-ink-2 mt-0.5">{d}</span></span>
            </button>
          ))}
        </div>

        {fill === "code" ? (
          <div className="mt-5 rounded-2xl border border-line bg-surface p-4 sm:p-5 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Input aria-label="Resume name" className="max-w-xs" value={codeTitle} maxLength={120} onChange={(e) => setCodeTitle(e.target.value)} placeholder="Resume name" />
              <label className="inline-flex items-center gap-1.5 h-10 rounded-lg border border-line-strong px-3 text-sm cursor-pointer hover:bg-surface-2">
                <FileUp aria-hidden className="size-4" />Open .tex file
                <input type="file" accept=".tex,text/x-tex,text/plain" className="sr-only" onChange={(e) => void loadTex(e.target.files?.[0])} />
              </label>
            </div>
            <Textarea aria-label="LaTeX code" rows={14} spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)}
              className="font-mono text-[12.5px]" placeholder={"\\documentclass{article}\n\\begin{document}\n...\n\\end{document}"} />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" loading={creating === "custom"} disabled={!/\\begin\{document\}/.test(code)} onClick={createFromCode}>Open in editor</Button>
              <span className="text-[13px] text-muted">Works with Overleaf code. Images and custom .cls files aren&apos;t supported.</span>
            </div>
          </div>
        ) : (
          <>
            {fill === "mine" ? <div className="mt-4 max-w-xl"><ResumeVersionSelect value={pick} onChange={setPick} label="Use this resume" autoSelect /></div> : null}
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
            <p className="text-sm text-ink-2 mt-5 mb-3">Choose a template — you can switch later without losing anything.</p>
            <TemplateGallery onPick={start} busyId={creating} />
          </>
        )}
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
