"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, sessionPost } from "@/lib/api";
import { Button, ErrorState, Field, Input, Notice } from "@/components/ui/primitives";

function safeNext(n: string | undefined): string {
  return n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") ? n : "/";
}

const toApiError = (err: unknown) =>
  err instanceof ApiError ? err : new ApiError({ status: 0, code: "unknown", message: "Something went wrong." });

type LoginResult = { user?: unknown; mfa_required?: boolean; mfa_token?: string; expires_in?: number };

export function AuthForm({ mode, next }: { mode: "login" | "register"; next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [challenge, setChallenge] = useState<string | null>(null);
  const [restartNote, setRestartNote] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reg = mode === "register";

  const finish = () => {
    router.replace(reg ? "/onboarding" : safeNext(next));
    router.refresh();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!email.includes("@")) errs.email = "Enter a valid email address.";
    if (reg && password.length < 10) errs.password = "Use at least 10 characters.";
    if (!reg && !password) errs.password = "Enter your password.";
    setLocal(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    setRestartNote(false);
    try {
      const body: Record<string, string> = { email, password };
      if (reg) {
        if (displayName.trim()) body.display_name = displayName.trim();
        try {
          body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        } catch {
          body.timezone = "UTC";
        }
      }
      const out = await sessionPost<LoginResult>(mode, body);
      if (!reg && out?.mfa_required && out.mfa_token) {
        setChallenge(out.mfa_token);
        setPassword("");
        setBusy(false);
        return;
      }
      finish();
    } catch (err) {
      setError(toApiError(err));
      setBusy(false);
    }
  };

  const restart = (expired: boolean) => {
    setChallenge(null);
    setError(null);
    setRestartNote(expired);
    // Return focus to the start of the form so keyboard and screen-reader users land on the new step.
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  if (challenge) {
    return <MfaStep token={challenge} onDone={finish} onRestart={restart} />;
  }

  const fieldErr = (k: string) => local[k] || error?.fields?.[k] || null;
  const locked = error?.code === "account_locked";

  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 ref={headingRef} tabIndex={-1} className="serif text-4xl leading-tight focus:outline-none">{reg ? "Create your account" : "Sign in"}</h1>
      <p className="mt-2 text-ink-2 text-[15px]">
        {reg ? "Your data stays on this machine. You can export or delete it at any time." : "Welcome back to Elevate."}
      </p>
      <div aria-live="polite">
        {restartNote ? (
          <Notice tone="info" className="mt-6">That sign-in took too long, so it was cancelled for your security. Enter your email and password again.</Notice>
        ) : null}
      </div>
      <form onSubmit={submit} noValidate className="mt-8 flex flex-col gap-4" aria-describedby={error ? "auth-error" : undefined}>
        {reg ? (
          <Field label="Name (optional)">
            {(p) => <Input id={p.id} value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" maxLength={120} />}
          </Field>
        ) : null}
        <Field label="Email" error={fieldErr("email")} required>
          {(p) => (
            <Input id={p.id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"
              aria-invalid={p.invalid} aria-describedby={p.describedBy} required />
          )}
        </Field>
        <Field label="Password" error={fieldErr("password")} hint={reg ? "At least 10 characters." : undefined} required>
          {(p) => (
            <Input id={p.id} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete={reg ? "new-password" : "current-password"} aria-invalid={p.invalid} aria-describedby={p.describedBy}
              minLength={reg ? 10 : undefined} required />
          )}
        </Field>
        {!reg ? (
          <p className="-mt-2 text-[13px]">
            <Link className="text-accent underline underline-offset-4" href="/forgot-password">Forgot password?</Link>
          </p>
        ) : null}
        <div id="auth-error" aria-live="assertive">
          {error && !Object.keys(error.fields).length ? (
            locked ? (
              <Notice tone="danger" title="Sign-in is temporarily locked">
                There have been too many unsuccessful sign-in attempts for this account. Wait a few minutes and try again,
                or <Link className="text-accent underline underline-offset-4" href="/forgot-password">reset your password</Link>.
              </Notice>
            ) : (
              <ErrorState error={error} title={reg ? "Could not create the account" : "Could not sign in"} />
            )
          ) : null}
        </div>
        <Button type="submit" variant="primary" loading={busy} className="w-full">{reg ? "Create account" : "Sign in"}</Button>
      </form>
      <p className="mt-6 text-sm text-ink-2">
        {reg ? <>Already have an account? <Link className="text-accent underline underline-offset-4" href="/login">Sign in</Link></> :
          <>New here? <Link className="text-accent underline underline-offset-4" href="/register">Create an account</Link></>}
      </p>
      <p className="mt-2 text-[13px] text-muted">
        Read the <Link className="underline underline-offset-4" href="/privacy">data notice</Link> to see what is stored and where.
      </p>
    </div>
  );
}

/** Second sign-in step for accounts with two-step verification. */
function MfaStep({ token, onDone, onRestart }: { token: string; onDone: () => void; onRestart: (expired: boolean) => void }) {
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const first = useRef(true);

  useEffect(() => {
    // Entering the step: move focus to the heading so the new context is announced; switching mode: focus the input.
    if (first.current) {
      first.current = false;
      headingRef.current?.focus();
    } else {
      inputRef.current?.focus();
    }
  }, [recovery]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = recovery ? code.trim().toLowerCase() : code.replace(/\s+/g, "");
    if (!recovery && !/^\d{6}$/.test(value)) {
      setLocalErr("Enter the 6-digit code.");
      inputRef.current?.focus();
      return;
    }
    if (recovery && value.length < 6) {
      setLocalErr("Enter one of your recovery codes, for example a1b2c3-d4e5f6.");
      inputRef.current?.focus();
      return;
    }
    setLocalErr(null);
    setBusy(true);
    setError(null);
    try {
      await sessionPost("login/mfa", { mfa_token: token, code: value });
      onDone();
    } catch (err) {
      const apiErr = toApiError(err);
      setBusy(false);
      if (apiErr.code === "mfa_expired") {
        onRestart(true);
        return;
      }
      setError(apiErr);
      setCode("");
      inputRef.current?.focus();
    }
  };

  const invalid = error?.code === "invalid_mfa_code";
  const message = localErr || (invalid ? (recovery ? "That recovery code didn't work. Each code can be used once." : "That code didn't work. Check your authenticator app and try again.") : null);

  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 ref={headingRef} tabIndex={-1} className="serif text-4xl leading-tight focus:outline-none">Two-step verification</h1>
      <p className="mt-2 text-ink-2 text-[15px]">
        {recovery ? "Enter one of the recovery codes you saved when you turned on two-step verification." : "Enter the 6-digit code from your authenticator app."}
      </p>
      <form onSubmit={submit} noValidate className="mt-8 flex flex-col gap-4">
        <Field label={recovery ? "Recovery code" : "Authentication code"} error={message} required>
          {(p) => recovery ? (
            <Input ref={inputRef} id={p.id} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off"
              autoCapitalize="none" spellCheck={false} placeholder="a1b2c3-d4e5f6" className="font-mono" maxLength={20}
              aria-invalid={p.invalid} aria-describedby={p.describedBy} required />
          ) : (
            <Input ref={inputRef} id={p.id} value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
              inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={7} placeholder="123456"
              className="font-mono tracking-[0.3em]" aria-invalid={p.invalid} aria-describedby={p.describedBy} required />
          )}
        </Field>
        <div aria-live="assertive">
          {error && !invalid ? (
            error.code === "account_locked" ? (
              <Notice tone="danger" title="Sign-in is temporarily locked">
                There have been too many unsuccessful attempts. Wait a few minutes and try again.
              </Notice>
            ) : <ErrorState error={error} title="Could not sign in" />
          ) : null}
        </div>
        <Button type="submit" variant="primary" loading={busy} className="w-full">Verify and sign in</Button>
      </form>
      <div className="mt-6 flex flex-col items-start gap-2 text-sm">
        <Button variant="link" onClick={() => { setRecovery((r) => !r); setCode(""); setError(null); setLocalErr(null); }}>
          {recovery ? "Use your authenticator app instead" : "Use a recovery code instead"}
        </Button>
        <Button variant="link" className="text-ink-2" onClick={() => onRestart(false)}>Start over</Button>
      </div>
    </div>
  );
}
