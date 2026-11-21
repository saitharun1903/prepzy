"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Download, PenLine, Wand2 } from "lucide-react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import type { Accepted } from "@/lib/types";
import { LATEX_TEMPLATE_LIST, latexTemplate, toLatex, type TailoredResume } from "@/lib/resume-templates";
import { b64ToBlob, downloadBlob, safeFile, type CompileOut } from "@/lib/apply-kit";
import { OperationStatus } from "@/components/operation-status";
import { ScoreRing, type AtsResult } from "@/components/ats-report";
import { Button, ErrorState, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";

type FixResult = { resume: TailoredResume; added: string[]; renamed: string[]; dropped: string[]; job_title: string | null };

/** One click: rebuild the student's own resume in LaTeX with the job's keywords, then score the new PDF. */
export function AtsFix({ before, versionId, picked }: { before: AtsResult; versionId: string | null; picked: string[] }) {
  const router = useRouter();
  const { notify } = useToast();
  const [template, setTemplate] = useState("ats");
  const [opId, setOpId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fixed, setFixed] = useState<FixResult | null>(null);
  const [pdf, setPdf] = useState<CompileOut | null>(null);
  const [after, setAfter] = useState<AtsResult | null>(null);
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const renames = [...before.keywords.matched, ...before.keywords.alias_only]
    .filter((k) => k.exact === false && k.resume_term && k.job_term)
    .map((k) => ({ from_term: k.resume_term!, to_term: k.job_term! }));

  const start = async () => {
    setStarting(true);
    setError(null);
    setFixed(null);
    setAfter(null);
    setPdf(null);
    try {
      const job = before.job;
      const r = await apiFetch<Accepted>("ats/fix", { method: "POST", idempotencyKey: newIdempotencyKey(), body: {
        ...(versionId ? { resume_version_id: versionId } : { resume_text: before.parsed.text }),
        ...(job?.id ? { job_id: job.id } : { job_text: job?.text ?? "" }),
        job_title: job?.title ?? null, add_skills: picked, renames, template,
      } });
      setOpId(r.operation_id);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setStarting(false);
    }
  };

  const build = useCallback(async (res: TailoredResume, tpl: string) => {
    const s = ++seq.current;
    setWorking(true);
    try {
      const out = await apiFetch<CompileOut>("latex/compile", { method: "POST", body: { source: toLatex(res, tpl) } });
      if (s !== seq.current) return;
      setPdf(out);
      if (out.ok && out.pdf) {
        const fd = new FormData();
        fd.append("file", new File([b64ToBlob(out.pdf, "application/pdf")], "resume.pdf", { type: "application/pdf" }));
        if (before.job?.id) fd.append("job_id", before.job.id); else fd.append("job_text", before.job?.text ?? "");
        fd.append("ats", before.ats.id);
        const a = await apiFetch<AtsResult>("ats/check", { method: "POST", body: fd });
        if (s === seq.current) setAfter(a);
      }
    } catch (e) {
      if (s === seq.current) notify("error", (e as ApiError).message || "Couldn't build the PDF.");
    } finally {
      if (s === seq.current) setWorking(false);
    }
  }, [before, notify]);

  useEffect(() => { if (fixed) void build(fixed.resume, template); }, [fixed, template, build]);

  const name = fixed?.resume.name || "Resume";
  const save = async () => {
    if (!fixed) return;
    setSaving(true);
    try {
      const d = await apiFetch<{ id: string }>("latex/docs", { method: "POST", body: {
        title: `${name} — ${fixed.job_title || before.job?.title || "ATS fixed"}`.slice(0, 120), template, data: fixed.resume,
        source: toLatex(fixed.resume, template), job_id: before.job?.id ?? null } });
      router.push(`/resume-builder/${d.id}`);
    } catch (e) { notify("error", (e as ApiError).message); setSaving(false); }
  };

  return (
    <section aria-labelledby="fix-h" className="rounded-2xl border border-accent/30 bg-surface p-5 shadow-[0_18px_50px_-34px_rgba(15,29,51,0.55)]">
      <h2 id="fix-h" className="serif text-2xl">Fix my resume in one click</h2>
      <p className="text-[14px] text-ink-2 mt-1">
        Your own resume, rebuilt as a clean LaTeX PDF with the job&apos;s exact keywords.
        {picked.length ? <> Adds: <b>{picked.join(", ")}</b>.</> : <> Tap missing skills above that you really have to add them.</>}
        {renames.length ? <> Rewords: {renames.slice(0, 3).map((r) => `${r.from_term} → ${r.to_term}`).join(", ")}.</> : null}
        {" "}Nothing else is added.
      </p>

      <div role="radiogroup" aria-label="Template" className="mt-4 flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {LATEX_TEMPLATE_LIST.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={template === t.id} onClick={() => setTemplate(t.id)} title={t.tagline}
            className={cx("shrink-0 w-[78px] rounded-lg border p-1 text-[11px] text-center bg-white transition",
              template === t.id ? "border-accent ring-2 ring-accent/25" : "border-line hover:border-accent/50")}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/templates/${t.id}.png`} alt="" loading="lazy" className="h-[62px] w-full object-cover object-top rounded" />
            <span className="block mt-1 truncate text-ink-2">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="mt-4">
        <Button variant="primary" loading={starting || Boolean(opId)} onClick={start}>
          <Wand2 aria-hidden className="size-4" />{fixed ? "Fix again" : "Fix my resume"}
        </Button>
      </div>
      {opId ? <div className="mt-3"><OperationStatus<FixResult> compact opId={opId} label="Fixing your resume" onDone={(op) => {
        setOpId(null);
        if (op.result && "resume" in op.result) setFixed(op.result);
      }} /></div> : null}
      {error ? <div className="mt-3"><ErrorState error={error} title="Couldn't fix the resume" /></div> : null}

      {fixed ? (
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <ScoreRing value={before.score} size={72} />
              <ArrowRight aria-hidden className="size-5 text-muted" />
              {after ? <ScoreRing value={after.score} size={92} /> : <span className="text-sm text-muted">{working ? "Scoring…" : ""}</span>}
            </div>
            {after ? <p className="text-[14px] text-ink-2">New score for <b>{after.ats.name}</b>{after.keywords.missing.length ? <> · still missing: {after.keywords.missing.slice(0, 5).map((k) => k.job_term || k.label).join(", ")}</> : null}</p> : null}
            {fixed.added.length || fixed.renamed.length ? (
              <ul className="text-[13.5px] text-ink-2 list-disc pl-5">
                {fixed.added.length ? <li>Added to Skills: {fixed.added.join(", ")}</li> : null}
                {fixed.renamed.map((x) => <li key={x}>Reworded {x}</li>)}
              </ul>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={!pdf?.pdf || working} onClick={() => pdf?.pdf && downloadBlob(b64ToBlob(pdf.pdf, "application/pdf"), `${safeFile(name)}_Resume.pdf`)}>
                <Download aria-hidden className="size-4" />Download PDF
              </Button>
              <Button variant="secondary" loading={saving} onClick={save}><PenLine aria-hidden className="size-4" />Edit in Resume builder</Button>
            </div>
            <p className="text-[12.5px] text-muted">Check every line before you send it. {latexTemplate(template).label} template — switch above anytime.</p>
          </div>
          <div className="rounded-xl bg-[#e9e6de] p-3 grid place-items-center min-h-[240px]">
            {pdf?.pages?.[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`data:image/png;base64,${pdf.pages[0]}`} alt="Preview of your fixed resume" className={cx("w-full max-w-[520px] bg-white shadow-lg rounded-sm", working && "opacity-60")} />
            ) : <p className="text-sm text-muted">{working ? "Building your PDF…" : ""}</p>}
          </div>
        </div>
      ) : null}
    </section>
  );
}
