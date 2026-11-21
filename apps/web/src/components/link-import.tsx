"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { ClipboardPaste, Link2, Sparkles } from "lucide-react";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import type { CaptureOut } from "@/lib/types";
import { OperationStatus } from "@/components/operation-status";
import { Button, ErrorState, Input, cx } from "@/components/ui/primitives";


/** Paste a job link (LinkedIn, Naukri, Indeed, company/ATS pages) -> Prepzy reads and analyses it. */
export function LinkImport({ redirectTab = "match", title = "Analyse a job from its link", className }: {
  redirectTab?: string; title?: string; className?: string;
}) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [captured, setCaptured] = useState<CaptureOut | null>(null);
  const keyRef = useRef<string | null>(null);

  const go = (jobId: string) => router.push(`/jobs/${jobId}?tab=${redirectTab}`);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const u = url.trim();
    if (!u) return;
    setBusy(true);
    setError(null);
    keyRef.current = keyRef.current || newIdempotencyKey();
    try {
      const out = await apiFetch<CaptureOut>("jobs/import-link", { method: "POST", idempotencyKey: keyRef.current, body: { url: u, save: true } });
      keyRef.current = null;
      if (!out.operation_id) { go(out.job_id); return; }
      setCaptured(out);
    } catch (err) {
      keyRef.current = null;
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (t) setUrl(t);
    } catch { /* clipboard permission denied: the user can paste manually */ }
  };

  return (
    <section aria-labelledby="link-h" className={cx("rounded-2xl border border-line bg-surface p-4 sm:p-5 shadow-[0_14px_40px_-30px_rgba(15,29,51,0.5)]", className)}>
      <div className="flex items-start gap-3">
        <span className="grid place-items-center size-10 shrink-0 rounded-xl bg-accent-soft text-accent"><Link2 aria-hidden className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 id="link-h" className="font-semibold text-ink text-[17px]">{title}</h2>
          <p className="text-[13.5px] text-ink-2 mt-0.5">See your match, gaps and interview prep in seconds.</p>
        </div>
      </div>

      {captured?.operation_id ? (
        <div className="mt-4 flex flex-col gap-3">
          <OperationStatus opId={captured.operation_id} label="Reading and analysing the job"
            onDone={(op) => { if (op.state === "succeeded" || op.state === "partially_succeeded") go(captured.job_id); }} />
          <div><Button variant="secondary" onClick={() => go(captured.job_id)}>Open the job now</Button></div>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-4 flex flex-col gap-2" noValidate>
          <label htmlFor="job-link" className="sr-only">Job link</label>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Input id="job-link" type="url" inputMode="url" autoComplete="off" spellCheck={false} value={url} maxLength={2000}
                placeholder="https://www.linkedin.com/jobs/view/…" onChange={(e) => setUrl(e.target.value)}
                aria-invalid={Boolean(error)} className="pr-24" />
              <button type="button" onClick={paste} className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-medium text-accent hover:bg-accent-soft">
                <ClipboardPaste aria-hidden className="size-3.5" />Paste
              </button>
            </div>
            <Button type="submit" variant="primary" loading={busy} disabled={!url.trim()}>
              <Sparkles aria-hidden className="size-4" />Analyse
            </Button>
          </div>
          <p className="text-[12.5px] text-muted">Works with LinkedIn and most career sites. Naukri or Indeed? Open the job and click the Prepzy extension.</p>
          {error ? <ErrorState error={error} title="Couldn't read that link" /> : null}
        </form>
      )}
    </section>
  );
}
