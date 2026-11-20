"use client";

import { useState } from "react";
import { CheckCircle2, Download, Plug, ShieldCheck } from "lucide-react";
import { HOSTED } from "@/lib/hosting";
import { ApiError, sessionPost } from "@/lib/api";
import { Button, ErrorState, Notice, PageHeader, SectionTitle } from "@/components/ui/primitives";

const EXTENSION_ID = process.env.NEXT_PUBLIC_ELEVATE_EXTENSION_ID || "bjhbbpnbmichlooillmiaeofcioofkni";

type ChromeRuntime = {
  sendMessage: (id: string, msg: unknown, cb: (resp: unknown) => void) => void;
  lastError?: { message?: string };
};

function runtime(): ChromeRuntime | null {
  const c = (globalThis as unknown as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  return c?.runtime && typeof c.runtime.sendMessage === "function" ? c.runtime : null;
}

type State =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "connected" }
  | { kind: "missing"; detail?: string }
  | { kind: "rejected"; detail: string }
  | { kind: "error"; error: ApiError };

export default function ExtensionConnectPage() {
  const [state, setState] = useState<State>({ kind: "idle" });

  const connect = async () => {
    const rt = runtime();
    if (!rt) {
      setState({ kind: "missing" });
      return;
    }
    setState({ kind: "working" });
    let token: string;
    try {
      const grant = await sessionPost<{ refresh_token: string }>("extension-grant");
      token = grant.refresh_token;
    } catch (e) {
      setState({ kind: "error", error: e as ApiError });
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; setState({ kind: "missing", detail: "The extension did not respond." }); }
    }, 8000);
    try {
      rt.sendMessage(EXTENSION_ID, { type: "elevate.connect.v1", refresh_token: token }, (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const err = rt.lastError;
        if (err) {
          setState({ kind: "missing", detail: err.message });
          return;
        }
        const r = resp as { ok?: boolean; error?: string } | undefined;
        if (r && r.ok === true) setState({ kind: "connected" });
        else setState({ kind: "rejected", detail: r?.error || "The extension did not confirm the connection." });
      });
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      setState({ kind: "missing", detail: (e as Error).message });
    }
  };

  return (
    <>
      <PageHeader eyebrow="Browser extension" title="Capture jobs in one click"
        description="The extension sends the job posting you are looking at to this Prepzy installation, so you don't have to copy and paste." />

      <div className="grid gap-10 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-8">
          <section aria-labelledby="access-h">
            <SectionTitle id="access-h">What the extension can access</SectionTitle>
            <ul className="flex flex-col gap-3 text-sm text-ink-2">
              {[
                "Only the tab you click the extension on, and only at the moment you click it.",
                `It reads that page's visible text and job metadata, and sends it to ${HOSTED ? "your Prepzy account" : "this local Prepzy installation"}.`,
                "It does not read your browsing history, other tabs, or pages you have not clicked it on.",
                "Connecting gives the extension its own sign-in, which you can revoke with “Sign out everywhere” in Settings.",
              ].map((t) => (
                <li key={t} className="flex items-start gap-2"><ShieldCheck aria-hidden className="size-4 text-accent mt-0.5 shrink-0" />{t}</li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="connect-h">
            <SectionTitle id="connect-h">Connect</SectionTitle>
            <div aria-live="polite" className="flex flex-col gap-3">
              {state.kind === "connected" ? (
                <Notice tone="ok" title="Extension connected">
                  <span className="inline-flex items-center gap-1.5"><CheckCircle2 aria-hidden className="size-4" />The extension confirmed the connection. Open a job page and click the Prepzy icon.</span>
                </Notice>
              ) : null}
              {state.kind === "missing" ? (
                <Notice tone="warn" title="The extension was not found in this browser">
                  {state.detail ? <p className="mb-1 text-[13px]">Details: {state.detail}</p> : null}
                  <p>Install it first (see below), make sure it is enabled, then reload this page and try again. Connecting works in Chrome and Chromium-based browsers.</p>
                </Notice>
              ) : null}
              {state.kind === "rejected" ? <Notice tone="danger" title="The extension did not accept the connection">{state.detail}</Notice> : null}
              {state.kind === "error" ? <ErrorState error={state.error} title="Could not create a connection token" /> : null}
              <div>
                <Button variant="primary" loading={state.kind === "working"} onClick={connect}>
                  <Plug aria-hidden className="size-4" />{state.kind === "connected" ? "Connect again" : "Connect extension"}
                </Button>
              </div>
              <p className="text-[13px] text-muted">The connection token is handed straight to the extension and is not stored by this page.</p>
            </div>
          </section>
        </div>

        <aside aria-labelledby="install-h" className="rounded-xl border border-accent/30 bg-accent-soft p-5 h-fit">
          <h2 id="install-h" className="text-[15px] font-semibold mb-1">Install it in about a minute</h2>
          <p className="text-[13px] text-ink-2 mb-3">Works in Chrome, Edge, Brave and other Chromium browsers on a computer.</p>
          {HOSTED ? (
            <a href="/downloads/elevate-extension.zip" download
              className="mb-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink shadow-sm hover:brightness-110">
              <Download aria-hidden className="size-4" />Download the extension (.zip)
            </a>
          ) : null}
          <ol className="list-decimal pl-5 text-sm text-ink-2 flex flex-col gap-2">
            {HOSTED ? (
              <li>Download the file above and <strong>unzip</strong> it (right-click → Extract all / double-click on Mac).</li>
            ) : (
              <li>Build it from the project: <code className="font-mono text-[12px]">npm run build:extension</code>.</li>
            )}
            <li>Open <code className="font-mono text-[12px]">chrome://extensions</code> (or <code className="font-mono text-[12px]">edge://extensions</code>) and switch on <strong>Developer mode</strong> (top right).</li>
            <li>Click <strong>Load unpacked</strong> and choose the unzipped folder (the one that contains <code className="font-mono text-[12px]">manifest.json</code>).</li>
            <li>Pin it: click the puzzle icon in the toolbar, then the pin next to Prepzy.</li>
            <li>Come back to this page and click <strong>Connect extension</strong>.</li>
            <li>Open any job posting and click the Prepzy icon: the analysis starts by itself, then shows your match, a preparation plan and links to real interview experiences.</li>
          </ol>
          <p className="mt-3 text-[12px] text-muted break-all">Expected extension ID: {EXTENSION_ID}</p>
        </aside>
      </div>
    </>
  );
}
