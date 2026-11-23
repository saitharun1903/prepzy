"use client";

import { useEffect, useState, type FormEvent } from "react";
import { FileUp, Gauge } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { jobTitle } from "@/lib/format";
import type { JobSummary } from "@/lib/types";
import { AtsReport, type AtsResult } from "@/components/ats-report";
import { AtsFix } from "@/components/ats-fix";
import { ResumeVersionSelect, type VersionPick } from "@/components/resume-version-select";
import { Button, ErrorState, PageHeader, Select, Textarea, cx } from "@/components/ui/primitives";

type ResumeMode = "upload" | "saved";
type JobMode = "saved" | "link" | "text";

function Seg<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: [T, string][]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-lg bg-surface-2 p-0.5 gap-0.5">
      {items.map(([id, l]) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}
          className={cx("rounded-md px-2.5 py-1 text-[13px] font-medium", value === id ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink")}>{l}</button>
      ))}
    </div>
  );
}

export default function AtsPage() {
  const jobs = useApi<{ items: JobSummary[] }>("jobs", { limit: 100 });
  const systems = useApi<{ items: { id: string; name: string }[] }>("ats/systems");
  const [rmode, setRmode] = useState<ResumeMode>("saved");
  const [file, setFile] = useState<File | null>(null);
  const [pick, setPick] = useState<VersionPick>(null);
  const [jmode, setJmode] = useState<JobMode>("saved");
  const [jobId, setJobId] = useState("");
  const [link, setLink] = useState("");
  const [text, setText] = useState("");
  const [ats, setAts] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<{ r: AtsResult; versionId: string | null } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Opened from the extension or a job page: /ats?job_id=… preselects that saved job.
  useEffect(() => {
    const j = new URLSearchParams(window.location.search).get("job_id");
    if (j && /^[0-9a-f-]{36}$/i.test(j)) { setJmode("saved"); setJobId(j); }
  }, []);
  const hasJobs = Boolean(jobs.data?.items.length);
  const job = jobId || jobs.data?.items[0]?.id || "";
  const ready = (rmode === "upload" ? Boolean(file) : Boolean(pick?.versionId))
    && (jmode === "saved" ? Boolean(job) : jmode === "link" ? Boolean(link.trim()) : text.trim().length >= 80);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      if (rmode === "upload" && file) fd.append("file", file);
      if (rmode === "saved" && pick?.versionId) fd.append("resume_version_id", pick.versionId);
      if (jmode === "saved") fd.append("job_id", job);
      if (jmode === "link") fd.append("job_url", link.trim());
      if (jmode === "text") fd.append("job_text", text);
      fd.append("ats", ats);
      const r = await apiFetch<AtsResult>("ats/check", { method: "POST", body: fd });
      setResult({ r, versionId: rmode === "saved" ? pick?.versionId ?? null : null });
      setPicked(new Set());
      setTimeout(() => document.getElementById("ats-result")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="ATS checker" description="See your resume the way a company's screening software does — and fix it in one click." />

      <form onSubmit={submit} noValidate className="rounded-2xl border border-line bg-surface p-4 sm:p-5 mb-8">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="font-semibold text-ink">Your resume</h2>
              <Seg label="Resume source" value={rmode} onChange={setRmode} items={[["saved", "My resumes"], ["upload", "Upload"]]} />
            </div>
            {rmode === "upload" ? (
              <label className="flex items-center gap-3 rounded-xl border-2 border-dashed border-line-strong px-4 py-3.5 cursor-pointer hover:border-accent/60">
                <FileUp aria-hidden className="size-5 text-accent shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink truncate">{file ? file.name : "Choose your PDF or DOCX"}</span>
                  <span className="block text-[12px] text-muted">The same file you&apos;ll send to the company</span>
                </span>
                <input type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr-only"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </label>
            ) : <ResumeVersionSelect value={pick} onChange={setPick} label="Resume" autoSelect />}
          </div>

          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="font-semibold text-ink">The job</h2>
              <Seg label="Job source" value={jmode} onChange={setJmode} items={[["saved", "My jobs"], ["link", "Link"], ["text", "Paste"]]} />
            </div>
            {jmode === "saved" ? (
              <Select aria-label="Job" value={job} onChange={(e) => setJobId(e.target.value)}>
                {hasJobs ? jobs.data!.items.map((j) => <option key={j.id} value={j.id}>{jobTitle(j)}{j.company ? ` — ${j.company}` : ""}</option>)
                  : <option value="">No saved jobs — use Link or Paste</option>}
              </Select>
            ) : jmode === "link" ? (
              <input aria-label="Job link" type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="Paste the job link"
                className="w-full h-10 rounded-lg border border-line-strong bg-white px-3 text-sm outline-none focus:border-accent" />
            ) : <Textarea aria-label="Job description" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the job description" />}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" loading={busy} disabled={!ready}><Gauge aria-hidden className="size-4" />Check my score</Button>
          <label className="inline-flex items-center gap-2 text-[13px] text-ink-2">
            Company uses
            <select aria-label="ATS system" value={ats} onChange={(e) => setAts(e.target.value)}
              className="h-8 rounded-lg border border-line-strong bg-white px-2 text-[13px]">
              <option value="auto">Auto-detect</option>
              {systems.data?.items.filter((s) => s.id !== "generic").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              <option value="generic">Not sure</option>
            </select>
          </label>
        </div>
      </form>

      {error ? <div className="mb-6"><ErrorState error={error} title="Couldn't check this resume" /></div> : null}
      {result ? (
        <div id="ats-result" className="flex flex-col gap-6 scroll-mt-6">
          <section className="rounded-2xl border border-line bg-surface p-5">
            <AtsReport r={result.r} picked={picked} onPickAll={(ls) => setPicked(new Set(ls))}
              onPick={(l) => setPicked((s) => { const n = new Set(s); if (n.has(l)) n.delete(l); else n.add(l); return n; })} />
          </section>
          <AtsFix before={result.r} versionId={result.versionId} picked={[...picked]} onPickAll={(ls) => setPicked(new Set(ls))} />
        </div>
      ) : null}
    </>
  );
}
