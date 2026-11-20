"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MailCheck, XCircle } from "lucide-react";
import { ApiError, sessionPost } from "@/lib/api";
import { Button, ButtonLink, ErrorState, Field, Input, Notice, Spinner } from "@/components/ui/primitives";

const toApiError = (err: unknown) =>
  err instanceof ApiError ? err : new ApiError({ status: 0, code: "unknown", message: "Something went wrong." });

const linkCls = "text-accent underline underline-offset-4";

/** Remove a one-time token from the address bar (history, screenshots, shoulder-surfing). */
function scrubTokenFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has("token")) {
      url.searchParams.delete("token");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
  } catch {
    /* ignore */
  }
}

/** Heading that receives focus when the view changes, so the new state is announced. */
function StepHeading({ children, focusKey }: { children: React.ReactNode; focusKey: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) ref.current?.focus();
    mounted.current = true;
  }, [focusKey]);
  return <h1 ref={ref} tabIndex={-1} className="serif text-4xl leading-tight focus:outline-none">{children}</h1>;
}

// ---------------------------------------------------------------- forgot password
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.includes("@")) {
      setLocalErr("Enter a valid email address.");
      return;
    }
    setLocalErr(null);
    setBusy(true);
    setError(null);
    try {
      const out = await sessionPost<{ message?: string }>("forgot-password", { email: email.trim() });
      setSent(out?.message || "If an account exists for that email, we've sent a link to reset the password.");
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-sm">
      <StepHeading focusKey={sent ? "sent" : "form"}>{sent ? "Check your email" : "Reset your password"}</StepHeading>
      <div aria-live="polite">
        {sent ? (
          <div className="mt-6 flex flex-col gap-4">
            <Notice tone="ok">{sent}</Notice>
            <p className="text-sm text-ink-2">
              The link expires after a short time and can be used once. If nothing arrives, check your spam folder or
              request another link.
            </p>
            <p className="text-sm text-ink-2">
              If this server isn&apos;t set up to send email, no message will arrive. In that case, ask the person who runs
              this Prepzy installation to reset your password for you.
            </p>
            <div className="flex flex-wrap gap-2">
              <ButtonLink href="/login" variant="primary">Back to sign in</ButtonLink>
              <Button variant="ghost" onClick={() => { setSent(null); setEmail(""); }}>Use a different email</Button>
            </div>
          </div>
        ) : null}
      </div>
      {!sent ? (
        <>
          <p className="mt-2 text-ink-2 text-[15px]">Enter the email you use for Prepzy and we&apos;ll send a link to choose a new password.</p>
          <form onSubmit={submit} noValidate className="mt-8 flex flex-col gap-4">
            <Field label="Email" error={localErr || error?.fields?.email || null} required>
              {(p) => (
                <Input id={p.id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"
                  aria-invalid={p.invalid} aria-describedby={p.describedBy} required />
              )}
            </Field>
            <div aria-live="assertive">
              {error && !error.fields?.email ? <ErrorState error={error} title="Could not send the link" /> : null}
            </div>
            <Button type="submit" variant="primary" loading={busy} className="w-full">Send reset link</Button>
          </form>
          <p className="mt-6 text-sm text-ink-2">
            Remembered it? <Link className={linkCls} href="/login">Sign in</Link>
          </p>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- reset password
export function ResetPasswordForm({ token: initialToken }: { token: string }) {
  const [token] = useState(initialToken);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"form" | "done" | "invalid">(initialToken.length >= 20 ? "form" : "invalid");
  const [error, setError] = useState<ApiError | null>(null);
  const [local, setLocal] = useState<Record<string, string>>({});

  useEffect(() => { scrubTokenFromUrl(); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (pw.length < 10) errs.new_password = "Use at least 10 characters.";
    if (confirm !== pw) errs.confirm = "The passwords don't match.";
    setLocal(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      await sessionPost("reset-password", { token, new_password: pw });
      setPw("");
      setConfirm("");
      setState("done");
    } catch (err) {
      const apiErr = toApiError(err);
      if (apiErr.code === "invalid_link") setState("invalid");
      else setError(apiErr);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-sm">
      <StepHeading focusKey={state}>
        {state === "done" ? "Password changed" : state === "invalid" ? "This link can't be used" : "Choose a new password"}
      </StepHeading>
      <div aria-live="polite">
        {state === "done" ? (
          <div className="mt-6 flex flex-col gap-4">
            <Notice tone="ok" title="Your password has been reset.">
              For your security, you have been signed out on every device, including the browser extension.
            </Notice>
            <ButtonLink href="/login" variant="primary" className="self-start">Sign in</ButtonLink>
          </div>
        ) : state === "invalid" ? (
          <div className="mt-6 flex flex-col gap-4">
            <Notice tone="danger">
              This password reset link is invalid, has already been used, or has expired.
            </Notice>
            <ButtonLink href="/forgot-password" variant="primary" className="self-start">Request a new link</ButtonLink>
          </div>
        ) : null}
      </div>
      {state === "form" ? (
        <form onSubmit={submit} noValidate className="mt-8 flex flex-col gap-4">
          <Field label="New password" hint="At least 10 characters." error={local.new_password || error?.fields?.new_password || null} required>
            {(p) => (
              <Input id={p.id} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password"
                minLength={10} aria-invalid={p.invalid} aria-describedby={p.describedBy} required />
            )}
          </Field>
          <Field label="Confirm new password" error={local.confirm || null} required>
            {(p) => (
              <Input id={p.id} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password"
                aria-invalid={p.invalid} aria-describedby={p.describedBy} required />
            )}
          </Field>
          <div aria-live="assertive">
            {error && !error.fields?.new_password ? <ErrorState error={error} title="Could not reset the password" /> : null}
          </div>
          <Button type="submit" variant="primary" loading={busy} className="w-full">Reset password</Button>
          <p className="text-[13px] text-muted">You will be signed out on every device.</p>
        </form>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- verify email
// One POST per token per page load, even when React (dev Strict Mode) runs effects twice.
const verifyCalls = new Map<string, Promise<void>>();

export function VerifyEmail({ token }: { token: string }) {
  const [state, setState] = useState<"working" | "ok" | "invalid" | "error">(token.length >= 20 ? "working" : "invalid");
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (token.length < 20) return;
    let alive = true;
    let p = verifyCalls.get(token);
    if (!p) {
      p = sessionPost("verify-email", { token }).then(() => undefined);
      verifyCalls.set(token, p);
    }
    scrubTokenFromUrl();
    p.then(() => { if (alive) setState("ok"); }).catch((err: unknown) => {
      if (!alive) return;
      const apiErr = toApiError(err);
      if (apiErr.code === "invalid_link") setState("invalid");
      else {
        verifyCalls.delete(token); // allow a manual retry for transient failures
        setError(apiErr);
        setState("error");
      }
    });
    return () => { alive = false; };
  }, [token, attempt]);

  return (
    <div className="mx-auto w-full max-w-sm">
      <StepHeading focusKey={state}>
        {state === "working" ? "Confirming your email" : state === "ok" ? "Email confirmed" : state === "invalid" ? "This link can't be used" : "Something went wrong"}
      </StepHeading>
      <div aria-live="polite" className="mt-6 flex flex-col gap-4">
        {state === "working" ? <Spinner label="Confirming your email address…" /> : null}
        {state === "ok" ? (
          <>
            <p className="flex items-start gap-2 text-ink-2">
              <MailCheck aria-hidden className="size-5 text-ok shrink-0 mt-0.5" />
              <span>Thanks — your email address is confirmed. AI analysis is available on your account.</span>
            </p>
            <ButtonLink href="/" variant="primary" className="self-start">Continue to Prepzy</ButtonLink>
          </>
        ) : null}
        {state === "invalid" ? (
          <>
            <p className="flex items-start gap-2 text-ink-2">
              <XCircle aria-hidden className="size-5 text-danger shrink-0 mt-0.5" />
              <span>This confirmation link is invalid, has already been used, or has expired.</span>
            </p>
            <p className="text-sm text-ink-2">
              Sign in and use <span className="font-medium text-ink">Resend link</span> in Settings to get a new one. If you
              already confirmed your address, there&apos;s nothing else to do.
            </p>
            <div className="flex flex-wrap gap-2">
              <ButtonLink href="/settings" variant="primary">Go to Settings</ButtonLink>
              <ButtonLink href="/login" variant="ghost">Sign in</ButtonLink>
            </div>
          </>
        ) : null}
        {state === "error" ? (
          <>
            <ErrorState error={error} title="Could not confirm your email" />
            <Button className="self-start" onClick={() => { setError(null); setState("working"); setAttempt((a) => a + 1); }}>
              Try again
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
