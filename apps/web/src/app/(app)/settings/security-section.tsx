"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Copy, Download, KeyRound, ShieldCheck } from "lucide-react";
import { ApiError, apiFetch, holdUnauthenticatedRedirect, sessionPost } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { MfaSetup, MfaStatus } from "@/lib/types";
import { useSession } from "@/components/shell/session";
import {
  Badge, Button, Checkbox, ErrorState, Field, Input, Notice, ResendVerification, SectionTitle, Skeleton,
} from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

const toApiError = (err: unknown) =>
  err instanceof ApiError ? err : new ApiError({ status: 0, code: "unknown", message: "Something went wrong." });

/** Copy text; falls back to a hidden textarea where the async clipboard API is unavailable (non-HTTPS). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyButton({ text, label, size = "sm" }: { text: string; label: string; size?: "sm" | "md" }) {
  const [done, setDone] = useState<null | boolean>(null);
  useEffect(() => {
    if (done === null) return;
    const t = setTimeout(() => setDone(null), 2500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <>
      <Button size={size} onClick={async () => setDone(await copyText(text))}>
        {done ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
        {done ? "Copied" : label}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {done === true ? "Copied to the clipboard." : done === false ? "Could not copy. Select the text and copy it manually." : ""}
      </span>
    </>
  );
}

function EmailVerification() {
  const { me } = useSession();
  if (!me) return <Skeleton className="h-12 max-w-xl" />;
  const verified = me.user.email_verified !== false;
  const sec = me.account_security;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-ink">Email address</span>
        <span className="text-ink-2 break-all">{me.user.email}</span>
        {verified ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Not verified</Badge>}
      </div>
      {!verified ? (
        <>
          <p className="text-[13px] text-muted max-w-2xl">
            {sec?.require_verified_email
              ? "This server requires a confirmed email address before AI analysis can run."
              : "Confirming your address lets you recover your account by email."}
            {sec && !sec.email_delivery ? " Email delivery isn't set up on this server, so confirmation links can't be sent; ask the person who runs this installation for help." : null}
          </p>
          <div><ResendVerification deliveryConfigured={sec?.email_delivery} /></div>
        </>
      ) : null}
    </div>
  );
}

type Step =
  | { kind: "status" }
  | { kind: "setup"; data: MfaSetup }
  | { kind: "codes"; codes: string[] };

function TwoStep() {
  const router = useRouter();
  const { reloadMe } = useSession();
  const { notify } = useToast();
  const status = useApi<MfaStatus>("auth/mfa");
  const [step, setStep] = useState<Step>({ kind: "status" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [offOpen, setOffOpen] = useState(false);
  const [offPw, setOffPw] = useState("");
  const [offCode, setOffCode] = useState("");
  const [offError, setOffError] = useState<ApiError | null>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  // Move focus to the new step's heading so keyboard and screen-reader users follow the flow.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    stepHeading.current?.focus();
  }, [step.kind]);

  // While recovery codes are on screen the session has already been ended: don't bounce to /login on a 401.
  useEffect(() => {
    if (step.kind !== "codes") return;
    holdUnauthenticatedRedirect(true);
    return () => holdUnauthenticatedRedirect(false);
  }, [step.kind]);

  const startSetup = async () => {
    setBusy("setup");
    setError(null);
    try {
      const data = await apiFetch<MfaSetup>("auth/mfa/setup", { method: "POST" });
      setCode("");
      setStep({ kind: "setup", data });
    } catch (err) {
      const e = toApiError(err);
      if (e.code === "mfa_enabled") status.reload();
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const enable = async (e: FormEvent) => {
    e.preventDefault();
    const c = code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(c)) {
      setError(new ApiError({ status: 422, code: "validation_failed", message: "Enter the 6-digit code.", fields: { code: "Enter the 6-digit code from your app." } }));
      return;
    }
    setBusy("enable");
    setError(null);
    try {
      const out = await apiFetch<{ recovery_codes: string[] }>("auth/mfa/enable", { method: "POST", body: { code: c } });
      setSaved(false);
      setStep({ kind: "codes", codes: out.recovery_codes });
      // Turning this on ends existing sessions, including this one. End it cleanly now (revokes the refresh
      // token) so nothing lingers if the tab is closed before "Done".
      holdUnauthenticatedRedirect(true);
      void sessionPost("logout").catch(() => null);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  };

  const finish = () => {
    holdUnauthenticatedRedirect(false);
    router.replace("/login");
    router.refresh();
  };

  const download = (codes: string[]) => {
    const body = [
      "Elevate recovery codes",
      "Each code can be used once to sign in if you lose access to your authenticator app.",
      "",
      ...codes,
      "",
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "elevate-recovery-codes.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const turnOff = async () => {
    setBusy("off");
    setOffError(null);
    try {
      await apiFetch("auth/mfa/disable", { method: "POST", body: { password: offPw, code: offCode.trim() } });
      setOffOpen(false);
      notify("ok", "Two-step verification is off");
      status.reload();
      reloadMe();
    } catch (err) {
      setOffError(toApiError(err));
    } finally {
      setBusy(null);
    }
  };

  const heading = (text: string) => (
    <h3 ref={stepHeading} tabIndex={-1} className="text-sm font-semibold text-ink focus:outline-none">{text}</h3>
  );

  if (step.kind === "codes") {
    const all = step.codes.join("\n");
    return (
      <div className="flex flex-col gap-4 max-w-xl">
        {heading("Save your recovery codes")}
        <Notice tone="ok" title="Two-step verification is on.">
          If you lose your phone, each of these codes lets you sign in once. They won&apos;t be shown again — store them
          somewhere safe, like a password manager.
        </Notice>
        <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-md border border-line bg-surface-2 p-4 font-mono text-sm select-all">
          {step.codes.map((c) => <li key={c} className="break-all">{c}</li>)}
        </ul>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={all} label="Copy codes" />
          <Button size="sm" onClick={() => download(step.codes)}><Download aria-hidden className="size-4" />Download .txt</Button>
        </div>
        <Checkbox label="I've saved these recovery codes" checked={saved} onChange={(e) => setSaved(e.target.checked)}
          hint="You have been signed out. Sign in again with your password and a code from your authenticator app." />
        <div><Button variant="primary" disabled={!saved} onClick={finish}>Done — sign in again</Button></div>
      </div>
    );
  }

  if (step.kind === "setup") {
    const { data } = step;
    return (
      <div className="flex flex-col gap-4 max-w-xl">
        {heading("Set up two-step verification")}
        <ol className="list-decimal pl-5 text-sm text-ink-2 flex flex-col gap-1">
          <li>Open an authenticator app on your phone (for example 1Password, Google Authenticator or Microsoft Authenticator).</li>
          <li>Scan the QR code, or enter the setup key by hand.</li>
          <li>Enter the 6-digit code the app shows.</li>
        </ol>
        <div className="flex flex-col sm:flex-row gap-4 sm:items-start">
          {/* Server-generated SVG rendered as an image (never injected into the DOM). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:image/svg+xml;utf8,${encodeURIComponent(data.qr_svg)}`} alt="QR code to add Elevate to your authenticator app"
            width={192} height={192} className="size-48 shrink-0 rounded-md border border-line" />
          <div className="min-w-0 flex-1 flex flex-col gap-2">
            <p className="text-sm font-medium text-ink" id="mfa-secret-label">Setup key</p>
            <code aria-labelledby="mfa-secret-label" className="block rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-sm break-all select-all">
              {data.secret}
            </code>
            <div><CopyButton text={data.secret} label="Copy key" /></div>
          </div>
        </div>
        <form onSubmit={enable} noValidate className="flex flex-col gap-3">
          <Field label="6-digit code" error={error?.fields?.code || null} required>
            {(p) => (
              <Input id={p.id} value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))} inputMode="numeric"
                autoComplete="one-time-code" pattern="[0-9]*" maxLength={7} className="font-mono tracking-[0.3em] max-w-48"
                aria-invalid={p.invalid} aria-describedby={p.describedBy} required />
            )}
          </Field>
          <div aria-live="assertive">
            {error && !error.fields?.code ? <ErrorState error={error} title="Could not turn on two-step verification" /> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={busy === "enable"}>Turn on</Button>
            <Button variant="ghost" onClick={() => { setStep({ kind: "status" }); setError(null); }}>Cancel</Button>
          </div>
        </form>
      </div>
    );
  }

  if (status.loading && !status.data) return <Skeleton className="h-16 max-w-xl" />;
  if (status.error) return <ErrorState error={status.error} onRetry={status.reload} title="Could not load two-step verification" />;
  const s = status.data;
  return (
    <div className="flex flex-col gap-3 max-w-2xl">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {heading("Two-step verification")}
        {s?.enabled ? <Badge tone="ok" icon={<ShieldCheck aria-hidden className="size-3.5" />}>On</Badge> : <Badge>Off</Badge>}
      </div>
      {s?.enabled ? (
        <>
          <p className="text-sm text-ink-2">
            Signing in asks for a code from your authenticator app.{" "}
            <span className={s.recovery_codes_left <= 2 ? "text-warn font-medium" : undefined}>
              {s.recovery_codes_left} of 10 recovery codes left.
            </span>
          </p>
          {s.recovery_codes_left <= 2 ? (
            <Notice tone="warn">You&apos;re running low on recovery codes. Turn two-step verification off and on again to get a new set.</Notice>
          ) : null}
          <div>
            <Button onClick={() => { setOffOpen(true); setOffPw(""); setOffCode(""); setOffError(null); }}>Turn off</Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-2">Add a second step to sign-in: a code from an authenticator app on your phone.</p>
          <div aria-live="assertive">{error ? <ErrorState error={error} title="Could not start set-up" /> : null}</div>
          <div><Button variant="primary" loading={busy === "setup"} onClick={startSetup}><KeyRound aria-hidden className="size-4" />Set up</Button></div>
        </>
      )}

      <Dialog open={offOpen} onClose={() => setOffOpen(false)} title="Turn off two-step verification?"
        description="Your account will be protected by your password only."
        footer={<>
          <Button onClick={() => setOffOpen(false)}>Cancel</Button>
          <Button variant="danger" loading={busy === "off"} disabled={!offPw || offCode.trim().length < 6} onClick={turnOff}>Turn off</Button>
        </>}>
        <div className="flex flex-col gap-4">
          <Field label="Your password">
            {(p) => <Input id={p.id} type="password" autoComplete="current-password" value={offPw} onChange={(e) => setOffPw(e.target.value)} data-autofocus aria-invalid={p.invalid} aria-describedby={p.describedBy} />}
          </Field>
          <Field label="Authentication or recovery code" hint="A 6-digit code from your app, or one of your recovery codes." error={offError?.fields?.code || null}>
            {(p) => <Input id={p.id} value={offCode} onChange={(e) => setOffCode(e.target.value)} autoComplete="one-time-code" spellCheck={false}
              autoCapitalize="none" className="font-mono" maxLength={20} aria-invalid={p.invalid} aria-describedby={p.describedBy} />}
          </Field>
          <div aria-live="assertive">
            {offError && !offError.fields?.code ? <ErrorState error={offError} title="Could not turn it off" /> : null}
          </div>
        </div>
      </Dialog>
    </div>
  );
}

export function SecuritySection() {
  return (
    <section aria-labelledby="security-h" className="flex flex-col gap-6">
      <SectionTitle id="security-h">Security</SectionTitle>
      <EmailVerification />
      <div className="border-t border-line pt-6"><TwoStep /></div>
    </section>
  );
}
