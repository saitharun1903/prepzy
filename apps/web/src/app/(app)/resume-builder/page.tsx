"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FileCode2, Plus, Trash2 } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { relativeTime } from "@/lib/format";
import { LATEX_TEMPLATES, SAMPLE_RESUME, toLatex, type LatexStyle } from "@/lib/resume-templates";
import { TemplateThumb } from "@/components/resume/template-thumb";
import { Dialog } from "@/components/ui/dialog";
import { Button, EmptyState, ErrorState, LoadingBlock, PageHeader, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";

type DocSummary = { id: string; title: string; template: string; version: number; updated_at: string; job_id: string | null };

const NAME: Record<string, string> = Object.fromEntries(LATEX_TEMPLATES.map((t) => [t.id, t.name]));

export default function ResumeBuilderPage() {
  const router = useRouter();
  const { notify } = useToast();
  const docs = useApi<{ items: DocSummary[] }>("latex/docs");
  const [creating, setCreating] = useState<LatexStyle | null>(null);
  const [del, setDel] = useState<DocSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (t: LatexStyle) => {
    setCreating(t);
    try {
      const d = await apiFetch<{ id: string }>("latex/docs", {
        method: "POST", body: { title: `My resume (${NAME[t]})`, template: t, source: toLatex(SAMPLE_RESUME, t) },
      });
      router.push(`/resume-builder/${d.id}`);
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
      <PageHeader title="Resume builder" description="Write your resume in LaTeX with live preview — like Overleaf, inside Prepzy." />

      <section aria-labelledby="tpl-h" className="mb-12">
        <h2 id="tpl-h" className="serif text-2xl">Start a new resume</h2>
        <p className="text-sm text-ink-2 mt-1">Pick a template. It opens with sample text you replace with your own.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {LATEX_TEMPLATES.map((t) => (
            <button key={t.id} type="button" disabled={Boolean(creating)} onClick={() => create(t.id)}
              className={cx("group text-left rounded-2xl border border-line bg-surface p-4 flex flex-col gap-3 transition",
                "hover:border-accent/50 hover:shadow-[0_14px_36px_-24px_rgba(15,29,51,0.6)] disabled:opacity-60")}>
              <span className="grid place-items-center rounded-xl bg-[#f1ede4] py-4"><TemplateThumb id={t.id} className="h-36 w-auto" /></span>
              <span className="flex items-center justify-between gap-2">
                <span className="font-semibold text-ink">{t.name}</span>
                <span className="inline-flex items-center gap-1 text-[13px] font-medium text-accent">
                  {creating === t.id ? "Creating…" : <><Plus aria-hidden className="size-3.5" />Use</>}
                </span>
              </span>
              <span className="text-[13px] text-ink-2 -mt-2">{t.tagline}</span>
            </button>
          ))}
        </div>
        <p className="text-[13px] text-muted mt-3">
          Tip: open a job&apos;s <b>Resume</b> tab to generate a version tailored to that job, then edit it here.
        </p>
      </section>

      <section aria-labelledby="docs-h">
        <h2 id="docs-h" className="serif text-2xl mb-3">Your resumes</h2>
        {docs.loading && !docs.data ? <LoadingBlock rows={3} /> : null}
        {docs.error ? <ErrorState error={docs.error} onRetry={docs.reload} title="Couldn't load your resumes" /> : null}
        {docs.data && !docs.data.items.length ? (
          <EmptyState title="No resumes yet">Pick a template above to start.</EmptyState>
        ) : null}
        {docs.data?.items.length ? (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {docs.data.items.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                <span className="grid place-items-center size-9 rounded-xl bg-accent-soft text-accent shrink-0"><FileCode2 aria-hidden className="size-4.5" /></span>
                <div className="min-w-0 flex-1">
                  <Link href={`/resume-builder/${d.id}`} className="font-medium text-ink hover:underline underline-offset-4 break-words">{d.title}</Link>
                  <p className="text-[13px] text-muted">{NAME[d.template] ?? "Custom"} · edited {relativeTime(d.updated_at)}</p>
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
