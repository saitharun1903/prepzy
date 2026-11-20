"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Download, FileText, Loader2, Pencil, Star, Trash2 } from "lucide-react";
import { ApiError, apiFetch, downloadFile, newIdempotencyKey } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatBytes, formatDate, humanize } from "@/lib/format";
import type { Operation, Resume, ResumeVersionMeta } from "@/lib/types";
import { useSession } from "@/components/shell/session";
import { OperationStatus } from "@/components/operation-status";
import {
  Badge, Button, EmptyState, ErrorState, Field, Input, LoadingBlock, Notice, PageHeader, SectionTitle, Select, TabPanel, Tabs, Textarea,
} from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

type ParseResult = { version_id: string; parse_status: string; message?: string; code?: string; skills?: number };

function ParseBadge({ v }: { v: ResumeVersionMeta }) {
  if (v.parse_status === "parsed") return <Badge tone="ok" icon={<CheckCircle2 aria-hidden className="size-3" />}>Parsed · {v.skill_count} skills</Badge>;
  if (v.parse_status === "pending") return <Badge tone="info" icon={<Loader2 aria-hidden className="size-3 spin" />}>Parsing</Badge>;
  return <Badge tone="danger" icon={<AlertTriangle aria-hidden className="size-3" />}>{humanize(v.parse_status)}</Badge>;
}

export default function ResumesPage() {
  const { me } = useSession();
  const { notify } = useToast();
  const resumes = useApi<Resume[]>("resumes");
  const [mode, setMode] = useState("upload");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [parsing, setParsing] = useState<{ opId: string; filename: string } | null>(null);
  const [parseOutcome, setParseOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [rename, setRename] = useState<{ r: Resume; name: string } | null>(null);
  const [del, setDel] = useState<{ kind: "resume"; r: Resume } | { kind: "version"; r: Resume; v: ResumeVersionMeta } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const maxMb = me?.limits.max_upload_mb;

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    if (maxMb && file.size > maxMb * 1024 * 1024) {
      setError(new ApiError({ status: 413, code: "file_too_large", message: `This file is ${formatBytes(file.size)}; the limit is ${maxMb} MB.` }));
      return;
    }
    setBusy(true);
    setError(null);
    setParseOutcome(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("name", name.trim());
      if (target) fd.append("resume_id", target);
      const r = await apiFetch<{ operation_id: string }>("resumes/upload", { method: "POST", body: fd, idempotencyKey: newIdempotencyKey() });
      setParsing({ opId: r.operation_id, filename: file.name });
      setFile(null);
      setName("");
      if (fileRef.current) fileRef.current.value = "";
      resumes.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const paste = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch("resumes/text", { method: "POST", body: { name: name.trim() || "Resume", text, resume_id: target || null, origin: "manual" } });
      notify("ok", "Resume text saved and parsed");
      setText("");
      setName("");
      resumes.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const onParsed = (op: Operation<ParseResult>) => {
    const res = op.result;
    if (op.state === "succeeded" && res?.parse_status === "parsed") {
      setParseOutcome({ ok: true, message: `${parsing?.filename || "Resume"} was read successfully: ${res.skills ?? 0} skills found.` });
    } else if (res?.message) {
      setParseOutcome({ ok: false, message: res.message });
    } else {
      setParseOutcome({ ok: false, message: op.error?.message || `Parsing ended: ${humanize(op.state)}.` });
    }
    setParsing(null);
    resumes.reload();
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notify("ok", ok);
      resumes.reload();
    } catch (e) {
      notify("error", (e as ApiError).message, undefined);
    }
  };

  const list = resumes.data || [];

  return (
    <>
      <PageHeader title="Resumes" description="Upload or paste your resume. Prepzy extracts skills, dated experience and education as evidence, and keeps every version." />

      <section aria-labelledby="add-h" className="mb-12">
        <SectionTitle id="add-h">Add a resume or a new version</SectionTitle>
        <Tabs label="Add resume method" tabs={[{ id: "upload", label: "Upload file" }, { id: "paste", label: "Paste text" }]} value={mode} onChange={(m) => { setMode(m); setError(null); }} />
        <TabPanel id={mode}>
          <form onSubmit={mode === "upload" ? upload : paste} className="flex flex-col gap-4 max-w-2xl" noValidate>
            {mode === "upload" ? (
              <Field label="Resume file" required
                hint={`Supported: ${(me?.limits.supported_resume_formats || ["pdf (text-based)", "docx"]).filter((f) => f !== "pasted text").join(", ")}${maxMb ? `, up to ${maxMb} MB` : ""}. Scanned or image-only PDFs cannot be read (no OCR) — paste the text instead.`}>
                {(p) => (
                  <input ref={fileRef} id={p.id} type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    aria-describedby={p.describedBy} onChange={(e) => setFile(e.target.files?.[0] || null)}
                    className="block w-full text-sm file:mr-3 file:h-10 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-4 file:text-sm file:text-ink hover:file:bg-surface-2" />
                )}
              </Field>
            ) : (
              <Field label="Resume text" required hint="At least 100 characters. Plain text is fine; keep section headings like Experience, Education, Skills." error={error?.fields?.text}>
                {(p) => <Textarea id={p.id} rows={12} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={p.describedBy} aria-invalid={p.invalid} />}
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Add to">
                {(p) => (
                  <Select id={p.id} value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="">A new resume</option>
                    {list.map((r) => <option key={r.id} value={r.id}>New version of “{r.name}”</option>)}
                  </Select>
                )}
              </Field>
              {!target ? (
                <Field label="Resume name (optional)">{(p) => <Input id={p.id} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Data analyst resume" />}</Field>
              ) : null}
            </div>
            {error ? <ErrorState error={error} title={mode === "upload" ? "Upload failed" : "Could not save the text"} /> : null}
            <div>
              <Button type="submit" variant="primary" loading={busy} disabled={mode === "upload" ? !file : text.trim().length < 100}>
                {mode === "upload" ? "Upload and read" : "Save text"}
              </Button>
            </div>
          </form>
          {parsing ? <div className="mt-4 max-w-2xl"><OperationStatus<ParseResult> opId={parsing.opId} label={`Reading ${parsing.filename}`} onDone={onParsed} /></div> : null}
          {parseOutcome ? (
            <Notice className="mt-4 max-w-2xl" tone={parseOutcome.ok ? "ok" : "danger"} title={parseOutcome.ok ? "Resume read" : "This file could not be read"} onDismiss={() => setParseOutcome(null)}>
              {parseOutcome.message}
              {!parseOutcome.ok ? " If it is a scanned PDF, use a text-based PDF or DOCX, or paste the text." : ""}
            </Notice>
          ) : null}
        </TabPanel>
      </section>

      <section aria-labelledby="list-h">
        <SectionTitle id="list-h">Your resumes</SectionTitle>
        {resumes.loading && !resumes.data ? <LoadingBlock rows={2} label="Loading resumes" /> : null}
        {resumes.error ? <ErrorState error={resumes.error} onRetry={resumes.reload} title="Could not load resumes" /> : null}
        {resumes.data && !list.length ? <EmptyState title="No resumes yet" icon={<FileText className="size-4" />}>Upload a file or paste text above.</EmptyState> : null}
        <div className="flex flex-col gap-6">
          {list.map((r) => (
            <article key={r.id} className="rounded-lg border border-line bg-surface">
              <header className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-line">
                <h3 className="font-medium text-ink break-words min-w-0">{r.name}</h3>
                {r.is_default ? <Badge tone="accent" icon={<Star aria-hidden className="size-3" />}>Default</Badge> : null}
                <div className="ml-auto flex flex-wrap gap-1">
                  {!r.is_default ? <Button size="sm" variant="ghost" onClick={() => act(() => apiFetch(`resumes/${r.id}/default`, { method: "POST" }), `${r.name} is now the default`)}>Make default</Button> : null}
                  <Button size="sm" variant="ghost" onClick={() => setRename({ r, name: r.name })}><Pencil aria-hidden className="size-3.5" />Rename</Button>
                  <Button size="sm" variant="ghost" onClick={() => setDel({ kind: "resume", r })}><Trash2 aria-hidden className="size-3.5" />Delete</Button>
                </div>
              </header>
              <ul className="divide-y divide-line">
                {r.versions.map((v) => (
                  <li key={v.id} className="px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {v.parse_status === "parsed" ? (
                          <Link href={`/resumes/${r.id}/${v.id}`} className="font-medium hover:underline underline-offset-4">Version {v.version}</Link>
                        ) : <span className="font-medium">Version {v.version}</span>}
                        <ParseBadge v={v} />
                        {v.reviewed_at ? <Badge tone="info">Reviewed</Badge> : null}
                      </div>
                      <p className="text-[13px] text-muted mt-0.5 break-words">
                        {v.origin === "upload" ? `${v.original_filename || "Uploaded file"} · ${formatBytes(v.size_bytes)}` : v.origin === "edited" ? "Edited text version" : "Pasted text"} · {formatDate(v.created_at)}
                      </p>
                      {v.parse_error ? <p className="text-[13px] text-danger mt-0.5">{v.parse_error}</p> : null}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {v.has_file ? (
                        <Button size="sm" variant="ghost" onClick={() => downloadFile(`resumes/${r.id}/versions/${v.id}/file`, v.original_filename || "resume").catch((e) => notify("error", (e as ApiError).message))}>
                          <Download aria-hidden className="size-3.5" />Original
                        </Button>
                      ) : null}
                      {v.parse_status === "parsed" ? (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => downloadFile(`resumes/${r.id}/versions/${v.id}/export`, `resume-v${v.version}.md`, { format: "md" }).catch((e) => notify("error", (e as ApiError).message))}>.md</Button>
                          <Button size="sm" variant="ghost" onClick={() => downloadFile(`resumes/${r.id}/versions/${v.id}/export`, `resume-v${v.version}.txt`, { format: "txt" }).catch((e) => notify("error", (e as ApiError).message))}>.txt</Button>
                        </>
                      ) : null}
                      <Button size="sm" variant="ghost" aria-label={`Delete version ${v.version}`} onClick={() => setDel({ kind: "version", r, v })}><Trash2 aria-hidden className="size-3.5" /></Button>
                    </div>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        {list.length ? <p className="mt-3 text-[13px] text-muted">Text exports contain the extracted text only, not the original layout.</p> : null}
      </section>

      <Dialog open={Boolean(rename)} onClose={() => setRename(null)} title="Rename resume"
        footer={<><Button onClick={() => setRename(null)}>Cancel</Button><Button variant="primary" disabled={!rename?.name.trim()} onClick={async () => {
          if (!rename) return;
          await act(() => apiFetch(`resumes/${rename.r.id}`, { method: "PATCH", body: { name: rename.name.trim() } }), "Renamed");
          setRename(null);
        }}>Save</Button></>}>
        {rename ? <Field label="Name">{(p) => <Input id={p.id} value={rename.name} maxLength={120} data-autofocus onChange={(e) => setRename({ ...rename, name: e.target.value })} />}</Field> : null}
      </Dialog>

      <Dialog open={Boolean(del)} onClose={() => setDel(null)}
        title={del?.kind === "resume" ? `Delete “${del.r.name}” and all its versions?` : del ? `Delete version ${del.v.version} of “${del.r.name}”?` : ""}
        description="This cannot be undone."
        footer={<><Button onClick={() => setDel(null)}>Cancel</Button><Button variant="danger" onClick={async () => {
          if (!del) return;
          if (del.kind === "resume") await act(() => apiFetch(`resumes/${del.r.id}`, { method: "DELETE" }), "Resume deleted");
          else await act(() => apiFetch(`resumes/${del.r.id}/versions/${del.v.id}`, { method: "DELETE" }), "Version deleted");
          setDel(null);
        }}>Delete</Button></>}>
        {del?.kind === "resume" ? (
          <ul className="list-disc pl-5 text-sm text-ink-2 flex flex-col gap-1">
            <li>All {del.r.versions.length} version(s) and their stored files are deleted.</li>
            <li>Match reports built from these versions are deleted.</li>
            <li>Applications that recorded a version keep their history but lose the link to it.</li>
          </ul>
        ) : del ? (
          <ul className="list-disc pl-5 text-sm text-ink-2 flex flex-col gap-1">
            <li>This version and its stored file are deleted. Other versions are kept.</li>
            <li>Match reports built from this version are deleted.</li>
            {del.r.versions.length === 1 ? <li>It is the only version, so the resume itself is removed too.</li> : null}
          </ul>
        ) : null}
      </Dialog>
    </>
  );
}
