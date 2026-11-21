"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Cloud, CloudOff, Code2, Download, Eye, FileCode2, Loader2, Play, ZoomIn, ZoomOut } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { useBeforeUnload } from "@/lib/hooks";
import type { LatexEditorHandle } from "@/components/resume/latex-editor";
import { Button, ErrorState, LoadingBlock, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";

// CodeMirror touches the DOM: load it on the client only.
const LatexEditor = dynamic(() => import("@/components/resume/latex-editor").then((m) => m.LatexEditor), {
  ssr: false, loading: () => <div className="h-full grid place-items-center text-sm text-muted">Loading editor…</div>,
});

type Doc = { id: string; title: string; template: string; version: number; source: string; updated_at: string };
type CompileOut = { ok: boolean; ms: number; page_count: number; errors: { line: number | null; message: string }[]; pdf: string | null; pages: string[]; log_tail: string };
type SaveState = "saved" | "saving" | "unsaved" | "error" | "conflict";

function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
const fileName = (t: string) => (t.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "resume").slice(0, 80);

export default function EditorPage({ params }: { params: Promise<{ docId: string }> }) {
  const { docId } = use(params);
  const { notify } = useToast();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [source, setSource] = useState("");
  const [title, setTitle] = useState("");
  const [save, setSave] = useState<SaveState>("saved");
  const [result, setResult] = useState<CompileOut | null>(null);
  const [compiledSource, setCompiledSource] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pane, setPane] = useState<"code" | "preview">("code");
  const version = useRef(0);
  const savedSource = useRef<string | null>(null);
  const editor = useRef<LatexEditorHandle | null>(null);
  const latest = useRef({ source: "", title: "" });
  latest.current = { source, title };

  useBeforeUnload(save === "unsaved" || save === "saving");

  // ---------------------------------------------------------------- load
  useEffect(() => {
    let alive = true;
    apiFetch<Doc>(`latex/docs/${docId}`)
      .then((d) => {
        if (!alive) return;
        setDoc(d); setSource(d.source); setTitle(d.title); version.current = d.version; savedSource.current = d.source;
      })
      .catch((e) => { if (alive) setLoadError(e as ApiError); });
    return () => { alive = false; };
  }, [docId]);

  // ---------------------------------------------------------------- compile
  const compile = useCallback(async (): Promise<CompileOut | null> => {
    const src = latest.current.source;
    if (!src.trim()) return null;
    setCompiling(true);
    setCompileError(null);
    try {
      const r = await apiFetch<CompileOut>("latex/compile", { method: "POST", body: { source: src } });
      setResult((prev) => (r.ok ? r : { ...r, pages: prev?.pages ?? [], pdf: prev?.pdf ?? null }));
      setCompiledSource(src);
      return r;
    } catch (e) {
      setCompileError((e as ApiError).message);
      return null;
    } finally {
      setCompiling(false);
    }
  }, []);

  useEffect(() => { if (doc) void compile(); }, [doc, compile]);

  // ---------------------------------------------------------------- autosave + autocompile
  const persist = useCallback(async (patch: { source?: string; title?: string }) => {
    setSave("saving");
    try {
      const r = await apiFetch<{ version: number }>(`latex/docs/${docId}`, { method: "PATCH", body: { ...patch, version: version.current } });
      version.current = r.version;
      if (patch.source !== undefined) savedSource.current = patch.source;
      setSave(latest.current.source === savedSource.current ? "saved" : "unsaved");
    } catch (e) {
      const err = e as ApiError;
      setSave(err.status === 409 ? "conflict" : "error");
    }
  }, [docId]);

  useEffect(() => {
    if (!doc || source === savedSource.current || save === "conflict") return;
    setSave("unsaved");
    const t = setTimeout(() => void persist({ source }), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => {
    if (!doc || !auto || source === compiledSource) return;
    const t = setTimeout(() => void compile(), 2500);
    return () => clearTimeout(t);
  }, [source, auto, doc, compiledSource, compile]);

  const saveTitle = () => {
    const t = title.trim();
    if (!doc || !t || t === doc.title) return;
    setDoc({ ...doc, title: t });
    void persist({ title: t });
  };

  // ---------------------------------------------------------------- downloads
  const downloadPdf = async () => {
    const r = result?.ok && compiledSource === source ? result : await compile();
    if (r?.ok && r.pdf) download(b64ToBlob(r.pdf, "application/pdf"), `${fileName(title)}.pdf`);
    else notify("error", "Fix the errors shown in the preview first, then download.");
  };

  if (loadError) return <ErrorState error={loadError} title={loadError.status === 404 ? "This resume was not found." : "Couldn't open this resume"} />;
  if (!doc) return <LoadingBlock rows={6} label="Opening resume" />;

  const errors = result && !result.ok ? result.errors : [];
  const stale = compiledSource !== source;
  const SaveIcon = save === "saved" ? Cloud : save === "saving" ? Loader2 : CloudOff;
  const saveText = { saved: "Saved", saving: "Saving…", unsaved: "Unsaved changes", error: "Couldn't save — retrying on next edit", conflict: "Changed in another tab — reload" }[save];

  return (
    <div className="flex flex-col gap-3">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/resume-builder" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink"><ArrowLeft aria-hidden className="size-4" />Resumes</Link>
        <span className="text-line-strong">/</span>
        <label htmlFor="doc-title" className="sr-only">Resume name</label>
        <input id="doc-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="min-w-[9rem] flex-1 sm:flex-none sm:w-72 rounded-lg border border-transparent bg-transparent px-2 py-1 font-semibold text-ink hover:border-line focus:border-accent focus:bg-surface outline-none" />
        <span className={cx("inline-flex items-center gap-1 text-[12.5px]", save === "error" || save === "conflict" ? "text-danger" : "text-muted")} aria-live="polite">
          <SaveIcon aria-hidden className={cx("size-3.5", save === "saving" && "animate-spin")} />{saveText}
        </span>
        <span className="hidden sm:block flex-1" />
        <span className="basis-full sm:hidden" />
        <label className="hidden sm:inline-flex items-center gap-1.5 text-[13px] text-ink-2 cursor-pointer select-none">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="accent-[var(--accent)]" />Auto compile
        </label>
        <Button variant="primary" loading={compiling} onClick={() => void compile()} title="Recompile (Ctrl/⌘ + Enter)">
          <Play aria-hidden className="size-4" />Recompile
        </Button>
        <Button variant="secondary" onClick={downloadPdf} disabled={!result?.pdf}><Download aria-hidden className="size-4" />PDF</Button>
        <Button variant="ghost" onClick={() => download(new Blob([source], { type: "application/x-tex" }), `${fileName(title)}.tex`)}>
          <FileCode2 aria-hidden className="size-4" />.tex
        </Button>
      </div>

      {save === "conflict" ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-ink">
          This resume was changed in another tab. <button type="button" className="underline font-medium" onClick={() => window.location.reload()}>Reload</button> to get the latest version (copy your edits first).
        </p>
      ) : null}

      {/* mobile pane switch */}
      <div role="tablist" aria-label="View" className="lg:hidden inline-flex self-start rounded-xl bg-surface-2 p-1 gap-1">
        {([["code", "Code", Code2], ["preview", "Preview", Eye]] as const).map(([id, label, Icon]) => (
          <button key={id} type="button" role="tab" aria-selected={pane === id} onClick={() => setPane(id)}
            className={cx("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium", pane === id ? "bg-surface text-ink shadow-sm" : "text-ink-2")}>
            <Icon aria-hidden className="size-4" />{label}{id === "preview" && errors.length ? <span className="ml-1 rounded-full bg-danger px-1.5 text-[11px] text-white">{errors.length}</span> : null}
          </button>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2 h-[calc(100dvh-210px)] min-h-[520px]">
        {/* code */}
        <section aria-label="LaTeX code" className={cx("rounded-2xl border border-line bg-surface overflow-hidden flex flex-col min-h-0", pane !== "code" && "hidden lg:flex")}>
          <div className="flex items-center justify-between border-b border-line px-3 py-2 text-[12.5px] text-muted">
            <span className="inline-flex items-center gap-1.5 font-medium text-ink-2"><FileCode2 aria-hidden className="size-4" />main.tex</span>
            <span>Ctrl/⌘ + Enter to recompile</span>
          </div>
          <div className="flex-1 min-h-0">
            <LatexEditor value={source} onChange={setSource} onCompile={() => void compile()} handleRef={editor}
              errorLines={errors.map((e) => e.line ?? 0).filter(Boolean)} />
          </div>
        </section>

        {/* preview */}
        <section aria-label="PDF preview" className={cx("rounded-2xl border border-line bg-[#e9e6de] overflow-hidden flex flex-col min-h-0", pane !== "preview" && "hidden lg:flex")}>
          <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2 text-[12.5px] text-muted">
            {compiling ? <span className="inline-flex items-center gap-1.5"><Loader2 aria-hidden className="size-3.5 animate-spin" />Compiling…</span>
              : result?.ok ? <span className="inline-flex items-center gap-1.5 text-ok"><CheckCircle2 aria-hidden className="size-3.5" />{result.page_count} page{result.page_count === 1 ? "" : "s"} · {(result.ms / 1000).toFixed(1)}s{stale ? " · edited since" : ""}</span>
                : errors.length ? <span className="inline-flex items-center gap-1.5 text-danger"><AlertTriangle aria-hidden className="size-3.5" />{errors.length} error{errors.length === 1 ? "" : "s"}</span> : null}
            <span className="flex-1" />
            <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))} className="p-1 rounded hover:bg-surface-2"><ZoomOut aria-hidden className="size-4" /></button>
            <span className="w-10 text-center">{Math.round(zoom * 100)}%</span>
            <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(2, +(z + 0.15).toFixed(2)))} className="p-1 rounded hover:bg-surface-2"><ZoomIn aria-hidden className="size-4" /></button>
          </div>

          {errors.length || compileError ? (
            <div role="alert" className="border-b border-line bg-danger-soft px-3 py-2 max-h-40 overflow-auto">
              {compileError ? <p className="text-sm text-ink">{compileError}</p> : null}
              <ul className="flex flex-col gap-1">
                {errors.map((e, i) => (
                  <li key={i} className="text-[13px] text-ink">
                    {e.line ? (
                      <button type="button" className="font-semibold text-danger underline underline-offset-2 mr-1.5"
                        onClick={() => { setPane("code"); setTimeout(() => editor.current?.goToLine(e.line!), 30); }}>Line {e.line}</button>
                    ) : <b className="text-danger mr-1.5">Error</b>}
                    {e.message}
                  </li>
                ))}
              </ul>
              {result && !result.ok && result.pages.length ? <p className="text-[12px] text-muted mt-1">Showing the last version that compiled.</p> : null}
            </div>
          ) : null}

          <div className="flex-1 min-h-0 overflow-auto p-4">
            {result?.pages.length ? (
              <div className="mx-auto flex flex-col gap-4" style={{ width: `${zoom * 100}%`, maxWidth: zoom <= 1 ? 820 : undefined }}>
                {result.pages.map((p, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={`data:image/png;base64,${p}`} alt={`Page ${i + 1} of your resume`} className="w-full bg-white shadow-[0_10px_30px_-18px_rgba(15,29,51,0.6)]" />
                ))}
              </div>
            ) : (
              <div className="h-full grid place-items-center text-sm text-muted">{compiling ? "Compiling your resume…" : errors.length ? "Fix the error above and your PDF appears here." : "Press Recompile to see your PDF."}</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
