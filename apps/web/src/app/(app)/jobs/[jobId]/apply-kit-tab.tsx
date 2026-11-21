"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Download, FileText, Gauge, Info, Mail, MessageSquareText, PenLine, RefreshCw, ShieldCheck, Sparkles, Users, Wand2 } from "lucide-react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Accepted } from "@/lib/types";
import { LATEX_TEMPLATE_LIST, latexTemplate, toLatex, type TailorResult } from "@/lib/resume-templates";
import { LINKEDIN_LIMIT, b64ToBlob, downloadBlob, fitToPage, letterLatex, letterText, safeFile, type CompileOut, type Kit, type KitResult } from "@/lib/apply-kit";
import { ResumeVersionSelect, type VersionPick } from "@/components/resume-version-select";
import { OperationStatus } from "@/components/operation-status";
import { AtsReport, type AtsResult } from "@/components/ats-report";
import { Button, ErrorState, Input, Notice, Textarea, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";

const TPL_KEY = "prepzy:kit-template";

function CopyBtn({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const { notify } = useToast();
  return (
    <Button size="sm" variant="secondary" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1600); }
      catch { notify("error", "Couldn't copy — select the text and copy it manually."); }
    }}>
      {done ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}{done ? "Copied" : label}
    </Button>
  );
}

function Card({ icon, title, hint, actions, children }: { icon: ReactNode; title: string; hint?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-2xl border border-line bg-surface p-4 sm:p-5 flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2.5 min-w-0">
          <span className="grid place-items-center size-9 rounded-xl bg-accent-soft text-accent shrink-0">{icon}</span>
          <div className="min-w-0">
            <h3 className="font-semibold text-ink">{title}</h3>
            {hint ? <p className="text-[13px] text-muted">{hint}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

const autoRows = (s: string, min = 4) => Math.min(18, Math.max(min, Math.ceil(s.length / 85) + s.split("\n").length));

export function ApplyKitTab({ jobId, jobTitle, company }: { jobId: string; jobTitle: string; company: string | null | undefined }) {
  const router = useRouter();
  const { notify } = useToast();
  const saved = useApi<{ kit: KitResult | null; resume: TailorResult | null }>(`jobs/${jobId}/apply-kit`);
  const [pick, setPick] = useState<VersionPick>(null);
  const [template, setTemplate] = useState("classic");
  const [ops, setOps] = useState<{ kit: string | null; resume: string | null }>({ kit: null, resume: null });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const [kitRes, setKitRes] = useState<KitResult | null>(null);
  const [kit, setKit] = useState<Kit | null>(null);
  const [resume, setResume] = useState<TailorResult | null>(null);

  const [pdf, setPdf] = useState<CompileOut | null>(null);
  const [fitted, setFitted] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [ats, setAts] = useState<AtsResult | null>(null);
  const [atsBusy, setAtsBusy] = useState(false);
  const [letterBusy, setLetterBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const compileSeq = useRef(0);

  useEffect(() => { try { const t = localStorage.getItem(TPL_KEY); if (t) setTemplate(latexTemplate(t).id); } catch { /* ignore */ } }, []);
  useEffect(() => { try { localStorage.setItem(TPL_KEY, template); } catch { /* ignore */ } }, [template]);

  // Load the last kit for this job (survives reloads and works on any device).
  useEffect(() => {
    const d = saved.data;
    if (!d) return;
    if (d.kit && !kitRes) { setKitRes(d.kit); setKit(d.kit.kit); }
    if (d.resume && !resume) setResume(d.resume);
  }, [saved.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    if (!pick?.versionId) return;
    setStarting(true);
    setError(null);
    try {
      const [k, r] = await Promise.all([
        apiFetch<Accepted>(`jobs/${jobId}/apply-kit`, { method: "POST", body: { resume_version_id: pick.versionId }, idempotencyKey: newIdempotencyKey() }),
        apiFetch<Accepted>(`resumes/${pick.resumeId}/versions/${pick.versionId}/tailored`, {
          method: "POST", body: { job_id: jobId, template }, idempotencyKey: newIdempotencyKey() }),
      ]);
      setOps({ kit: k.operation_id, resume: r.operation_id });
      setPdf(null);
      setAts(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setStarting(false);
    }
  };

  // Compile the tailored resume with the chosen template → real PDF + preview, then score it like an ATS would.
  const compile = useCallback(async (res: TailorResult, tpl: string) => {
    const seq = ++compileSeq.current;
    setCompiling(true);
    try {
      const { source, out } = await fitToPage(res.resume, tpl, (src) => apiFetch<CompileOut>("latex/compile", { method: "POST", body: { source: src } }));
      if (seq !== compileSeq.current) return;
      setPdf(out);
      setFitted(source);
      if (out.ok && out.pdf) {
        setAtsBusy(true);
        try {
          const fd = new FormData();
          fd.append("file", new File([b64ToBlob(out.pdf, "application/pdf")], "resume.pdf", { type: "application/pdf" }));
          fd.append("job_id", jobId);
          fd.append("ats", "auto");
          const a = await apiFetch<AtsResult>("ats/check", { method: "POST", body: fd });
          if (seq === compileSeq.current) setAts(a);
        } catch { /* the score is a bonus; the PDF still works */ }
        finally { if (seq === compileSeq.current) setAtsBusy(false); }
      }
    } catch (e) {
      if (seq === compileSeq.current) notify("error", (e as ApiError).message || "Couldn't build the PDF.");
    } finally {
      if (seq === compileSeq.current) setCompiling(false);
    }
  }, [jobId, notify]);

  useEffect(() => { if (resume) void compile(resume, template); }, [resume, template, compile]);

  const name = resume?.resume.name || null;
  const base = safeFile(`${name || "Resume"}_${company || jobTitle || "job"}`);
  const busy = Boolean(ops.kit || ops.resume) || starting;
  const setLetter = (p: Partial<Kit["cover_letter"]>) => kit && setKit({ ...kit, cover_letter: { ...kit.cover_letter, ...p } });
  const letterBody = kit ? kit.cover_letter.paragraphs.join("\n\n") : "";
  const mailto = kit ? `mailto:?subject=${encodeURIComponent(kit.cold_email.subject)}&body=${encodeURIComponent(kit.cold_email.body)}` : "";
  const liLen = kit?.linkedin_note.length ?? 0;

  const downloadLetter = async () => {
    if (!kit) return;
    setLetterBusy(true);
    try {
      const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
      const out = await apiFetch<CompileOut>("latex/compile", { method: "POST", body: { source: letterLatex(kit.cover_letter, resume?.resume ?? null, { company: company ?? kitRes?.company ?? null, date }) } });
      if (out.ok && out.pdf) downloadBlob(b64ToBlob(out.pdf, "application/pdf"), `${base}_Cover_Letter.pdf`);
      else notify("error", "Couldn't build the cover letter PDF. Copy the text instead.");
    } catch (e) {
      notify("error", (e as ApiError).message);
    } finally {
      setLetterBusy(false);
    }
  };

  const openBuilder = async () => {
    if (!resume) return;
    setOpening(true);
    try {
      const d = await apiFetch<{ id: string }>("latex/docs", { method: "POST", body: {
        title: `${resume.resume.name} — ${resume.job_title ?? jobTitle}`.slice(0, 120), template, job_id: jobId,
        data: resume.resume, source: fitted ?? toLatex(resume.resume, template) } });
      router.push(`/resume-builder/${d.id}`);
    } catch (e) { notify("error", (e as ApiError).message); setOpening(false); }
  };

  const hasAny = Boolean(kit || resume);

  return (
    <div className="flex flex-col gap-6">
      {/* 1 — set up */}
      <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5 shadow-[0_18px_50px_-34px_rgba(15,29,51,0.5)]">
        <div className="flex flex-col lg:flex-row lg:items-end gap-4">
          <div className="flex-1 min-w-0 max-w-md"><ResumeVersionSelect value={pick} onChange={setPick} label="Your resume" autoSelect /></div>
          <div className="flex flex-col gap-2 lg:items-end">
            <Button variant="primary" loading={busy} disabled={!pick?.versionId} onClick={start}>
              {hasAny ? <RefreshCw aria-hidden className="size-4" /> : <Wand2 aria-hidden className="size-4" />}
              {hasAny ? "Create again" : "Create my apply kit"}
            </Button>
          </div>
        </div>
        <p className="mt-3 text-[13px] text-muted inline-flex items-start gap-1.5">
          <ShieldCheck aria-hidden className="size-4 text-ok shrink-0 mt-px" />
          One click makes a tailored resume PDF, cover letter, LinkedIn note, referral request and cold email — written only from your resume. Anything that claims a skill or number you don&apos;t have is removed automatically.
        </p>
        {ops.resume || ops.kit ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {ops.resume ? <OperationStatus<TailorResult> compact opId={ops.resume} label="Tailored resume" onDone={(op) => {
              setOps((o) => ({ ...o, resume: null }));
              if (op.result && "resume" in op.result) setResume(op.result);
            }} /> : null}
            {ops.kit ? <OperationStatus<KitResult> compact opId={ops.kit} label="Cover letter & messages" onDone={(op) => {
              setOps((o) => ({ ...o, kit: null }));
              if (op.result && "kit" in op.result) { setKitRes(op.result); setKit(op.result.kit); notify("ok", "Your apply kit is ready"); }
            }} /> : null}
          </div>
        ) : null}
        {error ? <div className="mt-3"><ErrorState error={error} title="Couldn't start the apply kit" /></div> : null}
      </section>

      {saved.loading && !hasAny ? null : !hasAny && !busy ? (
        <div className="rounded-2xl border border-dashed border-line p-8 text-center text-ink-2">
          <Sparkles aria-hidden className="size-6 mx-auto text-accent" />
          <p className="mt-2 font-medium text-ink">Everything you need to apply, in one place</p>
          <ul className="mt-3 inline-flex flex-wrap justify-center gap-2 text-[13px]">
            {["Tailored resume (PDF)", "Cover letter", "LinkedIn note", "Referral request", "Cold email", "ATS score"].map((t) => (
              <li key={t} className="rounded-full bg-surface-2 px-3 py-1">{t}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {kitRes?.removed.length ? (
        <Notice tone="info" title={`Prepzy removed ${kitRes.removed.length} sentence${kitRes.removed.length === 1 ? "" : "s"} to keep this honest`}>
          They claimed skills or numbers that aren&apos;t in your resume. Read everything once before you send it.
        </Notice>
      ) : null}

      {/* 2 — resume + ATS */}
      {resume ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card icon={<FileText aria-hidden className="size-5" />} title="Tailored resume" hint={`For ${resume.job_title ?? jobTitle}${resume.company ? ` at ${resume.company}` : ""} · ${latexTemplate(template).label} template`}
            actions={<>
              <Button size="sm" variant="primary" disabled={!pdf?.pdf || compiling} onClick={() => pdf?.pdf && downloadBlob(b64ToBlob(pdf.pdf, "application/pdf"), `${base}_Resume.pdf`)}>
                <Download aria-hidden className="size-4" />PDF
              </Button>
              <Button size="sm" variant="secondary" loading={opening} onClick={openBuilder}><PenLine aria-hidden className="size-4" />Edit</Button>
            </>}>
            <div role="radiogroup" aria-label="Resume template" className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {LATEX_TEMPLATE_LIST.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={template === t.id} onClick={() => setTemplate(t.id)} title={t.tagline}
                  className={cx("shrink-0 w-[84px] rounded-lg border p-1 text-[11px] text-center transition bg-white",
                    template === t.id ? "border-accent ring-2 ring-accent/25" : "border-line hover:border-accent/50")}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/templates/${t.id}.png`} alt="" loading="lazy" className="h-[70px] w-full object-cover object-top rounded" />
                  <span className="block mt-1 truncate text-ink-2">{t.label}</span>
                </button>
              ))}
            </div>
            <div className="relative rounded-xl bg-[#e9e6de] p-3 min-h-[260px] grid place-items-center">
              {pdf?.pages?.[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`data:image/png;base64,${pdf.pages[0]}`} alt="Preview of your tailored resume" className={cx("w-full max-w-[560px] bg-white shadow-lg rounded-sm transition", compiling && "opacity-60")} />
              ) : <p className="text-sm text-muted">{compiling ? "Building your PDF…" : pdf && !pdf.ok ? "This template couldn't be built — try another." : ""}</p>}
              {pdf && pdf.page_count > 1 ? <span className="absolute left-4 top-4 rounded-full bg-warn/15 text-warn text-[12px] px-2 py-0.5">{pdf.page_count} pages — try a compact template</span> : null}
            </div>
            {resume.dropped.length ? <p className="text-[12.5px] text-muted inline-flex gap-1.5"><Info aria-hidden className="size-3.5 mt-0.5 shrink-0" />{resume.dropped.length} AI change{resume.dropped.length === 1 ? " was" : "s were"} removed because they added facts not in your resume.</p> : null}
          </Card>

          <Card icon={<Gauge aria-hidden className="size-5" />} title="ATS check of this PDF" hint="How the company's screening software reads the exact file you'll upload.">
            {ats ? <AtsReport r={ats} compact /> : <p className="text-sm text-muted py-6 text-center">{atsBusy || compiling ? "Scoring your resume…" : "The score appears once the PDF is built."}</p>}
          </Card>
        </div>
      ) : null}

      {/* 3 — messages */}
      {kit ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="min-w-0 lg:col-span-2">
            <Card icon={<FileText aria-hidden className="size-5" />} title="Cover letter" hint="Edit anything, then download or copy."
              actions={<>
                <Button size="sm" variant="primary" loading={letterBusy} onClick={downloadLetter}><Download aria-hidden className="size-4" />PDF</Button>
                <CopyBtn text={letterText(kit.cover_letter, name)} />
              </>}>
              <Input aria-label="Greeting" value={kit.cover_letter.greeting} onChange={(e) => setLetter({ greeting: e.target.value })} />
              <Textarea aria-label="Cover letter" rows={autoRows(letterBody, 10)} value={letterBody}
                onChange={(e) => setLetter({ paragraphs: e.target.value.split(/\n\s*\n/) })} />
              <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
                <Input aria-label="Closing" className="max-w-[200px]" value={kit.cover_letter.closing} onChange={(e) => setLetter({ closing: e.target.value })} />
                <span>{name}</span>
              </div>
            </Card>
          </div>

          <Card icon={<MessageSquareText aria-hidden className="size-5" />} title="LinkedIn note to the recruiter" hint="Paste it into “Add a note” when you connect."
            actions={<CopyBtn text={kit.linkedin_note} />}>
            <Textarea aria-label="LinkedIn note" rows={5} maxLength={LINKEDIN_LIMIT} value={kit.linkedin_note} onChange={(e) => setKit({ ...kit, linkedin_note: e.target.value })} />
            <p className={cx("text-[12px] text-right", liLen > LINKEDIN_LIMIT - 20 ? "text-warn" : "text-muted")}>{liLen}/{LINKEDIN_LIMIT} characters</p>
          </Card>

          <Card icon={<Users aria-hidden className="size-5" />} title="Referral request" hint="Send to someone who works there. Replace [Name]."
            actions={<CopyBtn text={kit.referral_message} />}>
            <Textarea aria-label="Referral request" rows={autoRows(kit.referral_message, 6)} value={kit.referral_message} onChange={(e) => setKit({ ...kit, referral_message: e.target.value })} />
          </Card>

          <div className="min-w-0 lg:col-span-2">
            <Card icon={<Mail aria-hidden className="size-5" />} title="Cold email to a recruiter or hiring manager" hint="Replace [Name], attach your resume PDF."
              actions={<>
                <a href={mailto} className="inline-flex items-center gap-1.5 h-8 rounded-lg px-3 text-sm font-medium bg-accent text-white hover:opacity-90"><Mail aria-hidden className="size-4" />Open in email</a>
                <CopyBtn text={`Subject: ${kit.cold_email.subject}\n\n${kit.cold_email.body}`} />
              </>}>
              <Input aria-label="Email subject" value={kit.cold_email.subject} onChange={(e) => setKit({ ...kit, cold_email: { ...kit.cold_email, subject: e.target.value } })} />
              <Textarea aria-label="Email body" rows={autoRows(kit.cold_email.body, 8)} value={kit.cold_email.body} onChange={(e) => setKit({ ...kit, cold_email: { ...kit.cold_email, body: e.target.value } })} />
            </Card>
          </div>

          {kit.highlights.length ? (
            <div className="lg:col-span-2 rounded-2xl bg-accent-soft p-4">
              <p className="text-sm font-medium text-ink">Facts from your resume used in these messages</p>
              <ul className="mt-1.5 list-disc pl-5 text-[13.5px] text-ink-2">{kit.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
