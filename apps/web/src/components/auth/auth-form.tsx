"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiError, sessionPost } from "@/lib/api";
import { Button, ErrorState, Field, Input } from "@/components/ui/primitives";

function safeNext(n: string | undefined): string {
  return n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") ? n : "/";
}

export function AuthForm({ mode, next }: { mode: "login" | "register"; next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [local, setLocal] = useState<Record<string, string>>({});
  const reg = mode === "register";

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
      await sessionPost(mode, body);
      router.replace(reg ? "/onboarding" : safeNext(next));
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError({ status: 0, code: "unknown", message: "Something went wrong." }));
      setBusy(false);
    }
  };

  const fieldErr = (k: string) => local[k] || error?.fields?.[k] || null;

  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 className="serif text-4xl leading-tight">{reg ? "Create your account" : "Sign in"}</h1>
      <p className="mt-2 text-ink-2 text-[15px]">
        {reg ? "Your data stays on this machine. You can export or delete it at any time." : "Welcome back to Elevate."}
      </p>
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
        <div id="auth-error" aria-live="assertive">
          {error && !Object.keys(error.fields).length ? <ErrorState error={error} title={reg ? "Could not create the account" : "Could not sign in"} /> : null}
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
