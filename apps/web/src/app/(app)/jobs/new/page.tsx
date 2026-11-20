"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { useBeforeUnload, useSessionDraft } from "@/lib/hooks";
import type { CaptureOut } from "@/lib/types";
import { useSession } from "@/components/shell/session";
import { OperationStatus } from "@/components/operation-status";
import { Button, Checkbox, ErrorState, Field, Input, Notice, PageHeader, Textarea } from "@/components/ui/primitives";
import { MODEL } from "@/lib/hosting";

export default function NewJobPage() {
  const router = useRouter();
  const { me } = useSession();
  const [text, setText, clearText] = useSessionDraft("elevate.jobdraft.text");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [captured, setCaptured] = useState<CaptureOut | null>(null);
  const keyRef = useRef<string | null>(null);
  const max = me?.limits.max_job_text_chars;

  useBeforeUnload(Boolean(text.trim()) && !captured);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (text.trim().length < 80) {
      setError(new ApiError({ status: 422, code: "validation_failed", message: "Paste the full posting (at least 80 characters).", fields: { text: "Too short" } }));
      return;
    }
    setBusy(true);
    setError(null);
    keyRef.current = keyRef.current || newIdempotencyKey();
    try {
      const out = await apiFetch<CaptureOut>("jobs/capture", {
        method: "POST",
        idempotencyKey: keyRef.current,
        body: {
          method: "manual", text, title: title.trim() || null, company: company.trim() || null, save,
          source: { url: url.trim() || null },
        },
      });
      clearText();
      keyRef.current = null;
      if (!out.operation_id) {
        router.push(`/jobs/${out.job_id}`);
        return;
      }
      setCaptured(out);
    } catch (err) {
      setError(err as ApiError);
      keyRef.current = null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader eyebrow="Jobs" title="Analyze a job" description="Paste the full text of one job posting. Prepzy extracts requirements and quotes the exact wording it relied on. English postings only." />

      {captured?.operation_id ? (
        <div className="flex flex-col gap-4 max-w-2xl">
          <Notice tone="ok" title={captured.new_job ? "Job saved" : "Added a new snapshot to an existing job"}>
            The text is stored. Analysis runs on {MODEL} and can take a minute or more.
          </Notice>
          <OperationStatus opId={captured.operation_id} label="Job analysis"
            onDone={(op) => {
              if (op.state === "succeeded" || op.state === "partially_succeeded") router.push(`/jobs/${captured.job_id}`);
            }} />
          <div className="flex gap-2">
            <Button onClick={() => router.push(`/jobs/${captured.job_id}`)}>Open the job now</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-5 max-w-3xl">
          <Field label="Job posting text" required error={error?.fields?.text ? (error.message || error.fields.text) : null}
            hint={`Paste the whole posting, including requirements.${max ? ` Up to ${max.toLocaleString()} characters.` : ""} Your draft is kept in this tab until you submit.`}>
            {(p) => (
              <Textarea id={p.id} rows={16} value={text} onChange={(e) => setText(e.target.value)} aria-invalid={p.invalid}
                aria-describedby={p.describedBy} maxLength={max} />
            )}
          </Field>
          <p className="text-[13px] text-muted -mt-3" aria-live="polite">{text.length.toLocaleString()} characters</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Job title (optional)">{(p) => <Input id={p.id} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />}</Field>
            <Field label="Company (optional)">{(p) => <Input id={p.id} value={company} maxLength={300} onChange={(e) => setCompany(e.target.value)} />}</Field>
            <Field label="Posting URL (optional)" className="sm:col-span-2" error={error?.fields?.["source.url"]} hint="Only http(s) links. Prepzy does not fetch the page.">
              {(p) => <Input id={p.id} type="url" value={url} maxLength={4000} onChange={(e) => setUrl(e.target.value)} aria-invalid={p.invalid} aria-describedby={p.describedBy} />}
            </Field>
          </div>
          <Checkbox checked={save} onChange={(e) => setSave(e.target.checked)} label="Save this job" hint="Saved jobs appear under the Saved filter. Unsaved jobs are still kept in your list." />
          {error && !error.fields?.text ? <ErrorState error={error} title="Could not submit the job" /> : null}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={busy}>Analyze</Button>
            {text ? <Button variant="ghost" onClick={() => { if (window.confirm("Clear the pasted text?")) clearText(); }}>Clear text</Button> : null}
          </div>
        </form>
      )}
    </>
  );
}
