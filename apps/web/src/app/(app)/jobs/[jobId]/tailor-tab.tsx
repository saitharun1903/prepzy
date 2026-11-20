"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, FileCode2, FileDown, Info, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import type { Accepted } from "@/lib/types";
import { TEMPLATES, toLatex, toPlainText, type TailorResult, type TemplateId } from "@/lib/resume-templates";
import { ResumeVersionSelect, type VersionPick } from "@/components/resume-version-select";
import { OperationStatus } from "@/components/operation-status";
import { ResumeSheet, ScaledSheet } from "@/components/resume/resume-sheet";
import { Button, ErrorState, Notice, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";

const KEY = (jobId: string) => `prepzy:tailored:${jobId}`;

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Small visual thumbnail so people can pick a template by eye. */
function TemplateThumb({ id }: { id: TemplateId }) {
  const accent = id === "classic" ? "#4f7ea0" : id === "modern" ? "#1b2f52" : "#111";
  const left = id === "modern";
  return (
    <svg viewBox="0 0 120 150" className="w-full h-auto rounded-md bg-white ring-1 ring-black/10" aria-hidden>
      <rect x={left ? 12 : 30} y="14" width="60" height="8" rx="2" fill={accent} />
      {id === "modern" ? <rect x="12" y="26" width="34" height="4" rx="2" fill="#c9a24b" /> : null}
      <rect x={left ? 12 : 22} y={id === "modern" ? 34 : 28} width="76" height="3" rx="1.5" fill="#9aa3b2" />
      {[48, 82, 112].map((y, k) => (
        <g key={k}>
          <rect x="12" y={y} width="34" height="4" rx="1" fill={accent} />
          <rect x="12" y={y + 6} width="96" height={id === "modern" && k === 0 ? 1.5 : 1} fill={id === "modern" ? "#c9a24b" : "#333"} />
          <rect x="14" y={y + 11} width="90" height="2.4" rx="1" fill="#c7ccd6" />
          <rect x="14" y={y + 16} width="80" height="2.4" rx="1" fill="#c7ccd6" />
          <rect x="14" y={y + 21} width="86" height="2.4" rx="1" fill="#c7ccd6" />
        </g>
      ))}
    </svg>
  );
}

export function TailorTab({ jobId, jobTitle }: { jobId: string; jobTitle: string }) {
  const { notify } = useToast();
  const [pick, setPick] = useState<VersionPick>(null);
  const [template, setTemplate] = useState<TemplateId>("classic");
  const [opId, setOpId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<TailorResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Keep the last result for this browser tab only (sessionStorage is cleared when the tab closes).
  useEffect(() => {
    setMounted(true);
    try {
      const raw = sessionStorage.getItem(KEY(jobId));
      if (raw) {
        const r = JSON.parse(raw) as TailorResult;
        setResult(r);
        setTemplate(r.template);
      }
    } catch { /* storage unavailable */ }
  }, [jobId]);
  useEffect(() => {
    try { if (result) sessionStorage.setItem(KEY(jobId), JSON.stringify({ ...result, template })); } catch { /* ignore */ }
  }, [result, template, jobId]);

  const generate = async () => {
    if (!pick?.versionId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<Accepted>(`resumes/${pick.resumeId}/versions/${pick.versionId}/tailored`, {
        method: "POST", body: { job_id: jobId, template }, idempotencyKey: newIdempotencyKey(),
      });
      setOpId(r.operation_id);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const fileBase = `${(result?.resume.name || "resume").replace(/[^\w]+/g, "_")}_${(jobTitle || "job").replace(/[^\w]+/g, "_")}`.slice(0, 80);

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="tpl-h" className="flex flex-col gap-4">
        <div>
          <h2 id="tpl-h" className="serif text-2xl">1. Choose a template</h2>
          <p className="text-sm text-ink-2 mt-1">All three are one-page, LaTeX-style layouts. You can switch templates after generating.</p>
        </div>
        <div role="radiogroup" aria-label="Resume template" className="grid gap-3 sm:grid-cols-3">
          {TEMPLATES.map((t) => {
            const on = template === t.id;
            return (
              <button key={t.id} type="button" role="radio" aria-checked={on} onClick={() => setTemplate(t.id)}
                className={cx("text-left rounded-2xl border p-3 flex flex-col gap-2 transition bg-surface",
                  on ? "border-accent ring-2 ring-accent/30 shadow-[0_12px_30px_-20px_rgba(15,29,51,0.6)]" : "border-line hover:border-accent/40")}>
                <TemplateThumb id={t.id} />
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-ink">{t.name}</span>
                  {on ? <span className="grid place-items-center size-5 rounded-full bg-accent text-white"><Check aria-hidden className="size-3.5" /></span> : null}
                </span>
                <span className="text-[13px] text-ink-2">{t.tagline}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="gen-h" className="flex flex-col gap-3">
        <h2 id="gen-h" className="serif text-2xl">2. Generate for this job</h2>
        <div className="max-w-xl"><ResumeVersionSelect value={pick} onChange={setPick} label="Start from this resume" autoSelect /></div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" loading={busy || Boolean(opId)} disabled={!pick?.versionId} onClick={generate}>
            {result ? <RefreshCw aria-hidden className="size-4" /> : <Wand2 aria-hidden className="size-4" />}
            {result ? "Generate again" : "Generate tailored resume"}
          </Button>
          <span className="text-[13px] text-muted inline-flex items-center gap-1.5">
            <Info aria-hidden className="size-3.5" />Uses only facts from your resume — nothing is invented.
          </span>
        </div>
        {opId ? (
          <OperationStatus<TailorResult> opId={opId} label="Tailored resume" onDone={(op) => {
            setOpId(null);
            if (op.result && "resume" in op.result) {
              setResult({ ...op.result, template });
              notify("ok", "Your tailored resume is ready");
            }
          }} />
        ) : null}
        {error ? <ErrorState error={error} title="Could not start generating" /> : null}
      </section>

      {result ? (
        <section aria-labelledby="out-h" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="out-h" className="serif text-2xl">3. Download</h2>
              <p className="text-sm text-ink-2 mt-1">Tailored for <b>{result.job_title}</b>{result.company ? <> at {result.company}</> : null}. Check every line before you send it.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => window.print()}>
                <FileDown aria-hidden className="size-4" />Download PDF
              </Button>
              <Button variant="secondary" onClick={() => download(`${fileBase}.tex`, toLatex(result.resume, template), "application/x-tex")}>
                <FileCode2 aria-hidden className="size-4" />LaTeX (.tex)
              </Button>
              <Button variant="ghost" onClick={async () => {
                try { await navigator.clipboard.writeText(toPlainText(result.resume)); setCopied(true); setTimeout(() => setCopied(false), 1800); }
                catch { notify("error", "Couldn't copy — select the text manually."); }
              }}>
                {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}{copied ? "Copied" : "Copy text"}
              </Button>
            </div>
          </div>
          <p className="text-[13px] text-muted">
            <b>PDF:</b> in the print window choose <i>Save as PDF</i>, paper A4, margins <i>None</i>, and tick <i>Background graphics</i>.{" "}
            <b>LaTeX:</b> open the .tex file in Overleaf (New project → Upload) and press Recompile.
          </p>
          {result.dropped.length ? (
            <Notice tone="info" title={`${result.dropped.length} AI suggestion${result.dropped.length === 1 ? " was" : "s were"} removed`}>
              They added facts that aren&apos;t in your resume (new skills, numbers or names), so Prepzy left them out.
            </Notice>
          ) : null}
          <div className="rounded-2xl bg-[#e9e6de] p-3 sm:p-6">
            <ScaledSheet><ResumeSheet resume={result.resume} template={template} /></ScaledSheet>
          </div>
          {mounted ? createPortal(<div className="resume-print"><ResumeSheet resume={result.resume} template={template} /></div>, document.body) : null}
        </section>
      ) : (
        <div className="rounded-2xl border border-dashed border-line p-8 text-center text-ink-2">
          <Sparkles aria-hidden className="size-6 mx-auto text-accent" />
          <p className="mt-2 font-medium text-ink">Your tailored resume will appear here</p>
          <p className="text-sm mt-1">Prepzy reorders your skills and projects so what this job asks for comes first, and writes a summary aimed at this role.</p>
        </div>
      )}
    </div>
  );
}
