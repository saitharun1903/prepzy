"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Download, FileCode2, FileText, Gauge, Loader2, Pencil, Star, Trash2, Upload } from "lucide-react";
import { ApiError, apiFetch, downloadFile, newIdempotencyKey } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { formatBytes, formatDate, humanize } from "@/lib/format";
import type { Operation, Resume, ResumeVersionMeta } from "@/lib/types";
import { useSession } from "@/components/shell/session";
import { OperationStatus } from "@/components/operation-status";
import {
  Badge, Button, EmptyState, ErrorState, Field, Input, LoadingBlock, Notice, PageHeader, SectionTitle, Select, Textarea, cx,
} from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

type ParseResult = { version_id: string; parse_status: string; message?: string; code?: string; skills?: number };

function ParseBadge({ v }: { v: ResumeVersionMeta }) {
  if (v.parse_status === "parsed") return <Badge tone="ok" icon={<CheckCircle2 aria-hidden className="size-3" />}>Ready · {v.skill_count} skills found</Badge>;
  if (v.parse_status === "pending") return <Badge tone="info" icon={<Loader2 aria-hidden className="size-3 spin" />}>Reading…</Badge>;
  return <Badge tone="danger" icon={<AlertTriangle aria-hidden className="size-3" />}>{humanize(v.parse_status)}</Badge>;
}

export default function ResumesPage() {
  const { me } = useSession();
  const { notify } = useToast();
  const resumes = useApi<Resume[]>("resumes");
  const [mode, setMode] = useState<"upload" | "paste">("upload");
  const [drag, setDrag] = useState(false);
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

  const VersionRow = ({ r, v, latest }: { r: Resume; v: ResumeVersionMeta; latest?: boolean }) => (
    <div className={latest ? "flex flex-col gap-3 sm:flex-row sm:items-center" : "flex flex-wrap items-center gap-2 py-2"}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {latest ? null : <span className="text-sm font-medium">Version {v.version}</span>}
          <ParseBadge v={v} />
        </div>
        <p className="text-[13px] text-muted mt-0.5 break-words">
          {v.origin === "upload" ? v.original_filename || "Uploaded file" : v.origin === "edited" ? "Edited text" : "Pasted text"} · {formatDate(v.created_at)}
        </p>
        {v.parse_error ? <p className="text-[13px] text-danger mt-0.5">{v.parse_error}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {latest && v.parse_status === "parsed" ? (
          <>
            <Link href="/ats" className="inline-flex items-center gap-1.5 h-8 rounded-lg bg-accent px-3 text-sm font-medium text-white hover:opacity-90"><Gauge aria-hidden className="size-4" />ATS score</Link>
            <Link href="/resume-builder" className="inline-flex items-center gap-1.5 h-8 rounded-lg border border-line-strong px-3 text-sm font-medium text-ink hover:bg-surface-2"><FileCode2 aria-hidden className="size-4" />Make LaTeX resume</Link>
            <Link href={`/resumes/${r.id}/${v.id}`} className="inline-flex items-center h-8 rounded-lg px-3 text-sm font-medium text-ink-2 hover:bg-surface-2">View</Link>
          </>
        ) : v.parse_status === "parsed" ? <Link href={`/resumes/${r.id}/${v.id}`} className="text-sm text-accent hover:underline underline-offset-4 px-2">View</Link> : null}
        {v.has_file ? (
          <button type="button" aria-label={`Download version ${v.version}`} title="Download the original file"
            onClick={() => downloadFile(`resumes/${r.id}/versions/${v.id}/file`, v.original_filename || "resume").catch((e) => notify("error", (e as ApiError).message))}
            className="p-2 rounded-lg text-muted hover:text-ink hover:bg-surface-2"><Download aria-hidden className="size-4" /></button>
        ) : null}
        {!latest || r.versions.length > 1 ? (
          <button type="button" aria-label={`Delete version ${v.version}`} title="Delete this version" onClick={() => setDel({ kind: "version", r, v })}
            className="p-2 rounded-lg text-muted hover:text-danger hover:bg-danger-soft"><Trash2 aria-hidden className="size-4" /></button>
        ) : null}
      </div>
    </div>
  );

  const pickFile = (f: File | null | undefined) => {
    if (!f) return;
    setFile(f);
    setError(null);
  };

  return (
    <>
      <PageHeader title="My resume" description="Upload it once — Prepzy compares every job with it." />

      <section aria-labelledby="add-h" className="mb-10">
        <h2 id="add-h" className="sr-only">Add a resume</h2>
        {mode === "upload" ? (
          <form onSubmit={upload} noValidate>
            <label
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); pickFile(e.dataTransfer.files?.[0]); }}
              className={cx("flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-8 text-center cursor-pointer transition",
                drag ? "border-accent bg-accent-soft" : "border-line-strong bg-surface hover:border-accent/60")}>
              <span className="grid place-items-center size-11 rounded-2xl bg-accent-soft text-accent"><Upload aria-hidden className="size-5" /></span>
              <span className="font-semibold text-ink">{file ? file.name : "Drop your resume here, or click to choose"}</span>
              <span className="text-[13px] text-muted">{file ? formatBytes(file.size) : `PDF or Word (.docx)${maxMb ? `, up to ${maxMb} MB` : ""}`}</span>
              <input ref={fileRef} type="file" className="sr-only" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(e) => pickFile(e.target.files?.[0])} />
            </label>
            {file ? (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {list.length ? (
                  <Select aria-label="Save as" className="max-w-xs" value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="">Save as a new resume</option>
                    {list.map((r) => <option key={r.id} value={r.id}>Update “{r.name}”</option>)}
                  </Select>
                ) : null}
                <Button type="submit" variant="primary" loading={busy}>Upload and read</Button>
                <Button type="button" variant="ghost" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }}>Cancel</Button>
              </div>
            ) : null}
          </form>
        ) : (
          <form onSubmit={paste} noValidate className="rounded-2xl border border-line bg-surface p-4 flex flex-col gap-3">
            <Textarea aria-label="Resume text" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste your whole resume — keep headings like Education, Skills, Projects." />
            <div className="flex flex-wrap items-center gap-3">
              {list.length ? (
                <Select aria-label="Save as" className="max-w-xs" value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Save as a new resume</option>
                  {list.map((r) => <option key={r.id} value={r.id}>Update “{r.name}”</option>)}
                </Select>
              ) : null}
              <Button type="submit" variant="primary" loading={busy} disabled={text.trim().length < 100}>Save</Button>
            </div>
          </form>
        )}
        <p className="mt-2 text-[13px] text-muted">
          {mode === "upload" ? <>Scanned PDF or no file? <button type="button" className="text-accent hover:underline underline-offset-4" onClick={() => { setMode("paste"); setError(null); }}>Paste the text instead</button></>
            : <button type="button" className="text-accent hover:underline underline-offset-4" onClick={() => { setMode("upload"); setError(null); }}>Upload a file instead</button>}
        </p>
        {error ? <div className="mt-3"><ErrorState error={error} title={mode === "upload" ? "Upload failed" : "Could not save the text"} /></div> : null}
        {parsing ? <div className="mt-3"><OperationStatus<ParseResult> opId={parsing.opId} label={`Reading ${parsing.filename}`} onDone={onParsed} /></div> : null}
        {parseOutcome ? (
          <Notice className="mt-3" tone={parseOutcome.ok ? "ok" : "danger"} title={parseOutcome.ok ? "Your resume is ready" : "This file could not be read"} onDismiss={() => setParseOutcome(null)}>
            {parseOutcome.message}
            {!parseOutcome.ok ? " If it is a scanned PDF, upload a text-based PDF or DOCX, or paste the text." : ""}
          </Notice>
        ) : null}
      </section>

      <section aria-labelledby="list-h">
        <SectionTitle id="list-h">Your resumes</SectionTitle>
        {resumes.loading && !resumes.data ? <LoadingBlock rows={2} label="Loading resumes" /> : null}
        {resumes.error ? <ErrorState error={resumes.error} onRetry={resumes.reload} title="Could not load resumes" /> : null}
        {resumes.data && !list.length ? <EmptyState title="No resume yet" icon={<FileText className="size-4" />}>Upload your resume above to get started.</EmptyState> : null}
        <div className="flex flex-col gap-4">
          {list.map((r) => {
            const [latest, ...older] = [...r.versions].sort((a, b) => b.version - a.version);
            return (
              <article key={r.id} className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
                <header className="flex flex-wrap items-center gap-2 mb-3">
                  <span className="grid place-items-center size-9 rounded-xl bg-accent-soft text-accent shrink-0"><FileText aria-hidden className="size-4.5" /></span>
                  <h3 className="font-semibold text-ink break-words min-w-0">{r.name}</h3>
                  {r.is_default ? <Badge tone="accent" icon={<Star aria-hidden className="size-3" />}>Main</Badge>
                    : <button type="button" className="text-[13px] text-accent hover:underline underline-offset-4" onClick={() => act(() => apiFetch(`resumes/${r.id}/default`, { method: "POST" }), `${r.name} is now your main resume`)}>Make main</button>}
                  <div className="ml-auto flex gap-1">
                    <button type="button" aria-label={`Rename ${r.name}`} title="Rename" onClick={() => setRename({ r, name: r.name })} className="p-2 rounded-lg text-muted hover:text-ink hover:bg-surface-2"><Pencil aria-hidden className="size-4" /></button>
                    <button type="button" aria-label={`Delete ${r.name}`} title="Delete" onClick={() => setDel({ kind: "resume", r })} className="p-2 rounded-lg text-muted hover:text-danger hover:bg-danger-soft"><Trash2 aria-hidden className="size-4" /></button>
                  </div>
                </header>
                {latest ? <VersionRow r={r} v={latest} latest /> : null}
                {older.length ? (
                  <details className="mt-3 group">
                    <summary className="cursor-pointer list-none text-[13px] text-ink-2 inline-flex items-center gap-1"><ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180" />Older versions ({older.length})</summary>
                    <div className="mt-1 divide-y divide-line">{older.map((v) => <VersionRow key={v.id} r={r} v={v} />)}</div>
                  </details>
                ) : null}
              </article>
            );
          })}
        </div>
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
