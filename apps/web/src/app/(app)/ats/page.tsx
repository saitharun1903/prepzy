"use client";

import { useState, type FormEvent } from "react";
import { FileUp, Gauge } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { jobTitle } from "@/lib/format";
import type { JobSummary } from "@/lib/types";
import { AtsReport, type AtsResult } from "@/components/ats-report";
import { ResumeVersionSelect, type VersionPick } from "@/components/resume-version-select";
import { Button, ErrorState, PageHeader, Select, Textarea, cx } from "@/components/ui/primitives";

type ResumeMode = "upload" | "saved";
type JobMode = "saved" | "link" | "text";

function Seg<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: [T, string][]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-xl bg-surface-2 p-1 gap-1 mb-3">
      {items.map(([id, l]) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}
          className={cx("rounded-lg px-3 py-1.5 text-sm font-medium", value === id ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink")}>{l}</button>
      ))}
    </div>
  );
}

export default function AtsPage() {
  const jobs = useApi<{ items: JobSummary[] }>("jobs", { limit: 100 });
  const systems = useApi<{ items: { id: string; name: string; style: string }[] }>("ats/systems");
  const [rmode, setRmode] = useState<ResumeMode>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [pick, setPick] = useState<VersionPick>(null);
  const [jmode, setJmode] = useState<JobMode>("saved");
  const [jobId, setJobId] = useState("");
  const [link, setLink] = useState("");
  const [text, setText] = useState("");
  const [ats, setAts] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<AtsResult | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      if (rmode === "upload" && file) fd.append("file", file);
      if (rmode === "saved" && pick?.versionId) fd.append("resume_version_id", pick.versionId);
      const job = jmode === "saved" ? jobId || jobs.data?.items[0]?.id || "" : "";
      if (job) fd.append("job_id", job);
      if (jmode === "link") fd.append("job_url", link.trim());
      if (jmode === "text") fd.append("job_text", text);
      fd.append("ats", ats);
      const r = await apiFetch<AtsResult>("ats/check", { method: "POST", body: fd });
      setResult(r);
      setTimeout(() => document.getElementById("ats-result")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="ATS score checker" description="See how a company's applicant tracking system reads your resume for a job — and exactly what to fix." />

      <form onSubmit={submit} className="grid gap-4 lg:grid-cols-3 mb-10" noValidate>
        <section className="rounded-2xl border border-line bg-surface p-4">
          <h2 className="font-semibold text-ink mb-2">1. Your resume</h2>
          <Seg label="Resume source" value={rmode} onChange={setRmode} items={[["upload", "Upload file"], ["saved", "My resumes"]]} />
          {rmode === "upload" ? (
            <label className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line-strong px-4 py-6 text-center cursor-pointer hover:border-accent/60">
              <FileUp aria-hidden className="size-6 text-accent" />
              <span className="text-sm font-medium text-ink">{file ? file.name : "Choose a PDF or DOCX"}</span>
              <span className="text-[12px] text-muted">The exact file you'll upload to the company (max 5 MB)</span>
              <input type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr-only"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          ) : <ResumeVersionSelect value={pick} onChange={setPick} label="Resume" autoSelect />}
        </section>

        <section className="rounded-2xl border border-line bg-surface p-4">
          <h2 className="font-semibold text-ink mb-2">2. The job</h2>
          <Seg label="Job source" value={jmode} onChange={setJmode} items={[["saved", "My jobs"], ["link", "Job link"], ["text", "Paste text"]]} />
          {jmode === "saved" ? (
            <Select aria-label="Job" value={jobId || jobs.data?.items[0]?.id || ""} onChange={(e) => setJobId(e.target.value)}>
              {jobs.data?.items.length ? jobs.data.items.map((j) => <option key={j.id} value={j.id}>{jobTitle(j)}{j.company ? ` — ${j.company}` : ""}</option>)
                : <option value="">No saved jobs — use a link or paste text</option>}
            </Select>
          ) : jmode === "link" ? (
            <input aria-label="Job link" type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://company.wd5.myworkdayjobs.com/…"
              className="w-full rounded-lg border border-line-strong bg-white px-3 py-2 text-sm outline-none focus:border-accent" />
          ) : <Textarea aria-label="Job description" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the full job description" />}
          <p className="text-[12px] text-muted mt-2">The link also tells us which ATS the company uses (Workday, Taleo, Greenhouse …).</p>
        </section>

        <section className="rounded-2xl border border-line bg-surface p-4 flex flex-col">
          <h2 className="font-semibold text-ink mb-2">3. ATS system</h2>
          <Select aria-label="ATS system" value={ats} onChange={(e) => setAts(e.target.value)}>
            <option value="auto">Detect from the job (recommended)</option>
            {systems.data?.items.filter((s) => s.id !== "generic").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="generic">Not sure — typical ATS</option>
          </Select>
          <p className="text-[12px] text-muted mt-2">{ats === "auto" ? "We'll detect it from the job link when we can." : systems.data?.items.find((s) => s.id === ats)?.style}</p>
          <span className="flex-1" />
          <Button type="submit" variant="primary" loading={busy} className="mt-4 w-full"
            disabled={(rmode === "upload" && !file) || (rmode === "saved" && !pick?.versionId) || (jmode === "link" && !link.trim()) || (jmode === "text" && text.trim().length < 80)}>
            <Gauge aria-hidden className="size-4" />Check my ATS score
          </Button>
        </section>
      </form>

      {error ? <div className="mb-6"><ErrorState error={error} title="Couldn't check this resume" /></div> : null}
      {result ? <div id="ats-result"><AtsReport r={result} /></div> : null}
    </>
  );
}
