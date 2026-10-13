"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CheckCircle2, CircleSlash, Download, Monitor, Moon, Plug, Sun } from "lucide-react";
import { ApiError, apiFetch, downloadFile, sessionPost } from "@/lib/api";
import { getThemePref, setThemePref, type ThemePref } from "@/lib/theme";
import type { Profile } from "@/lib/types";
import { useSession } from "@/components/shell/session";
import { profilePayload } from "@/components/profile-form";
import {
  Button, ButtonLink, ErrorState, Field, Input, Notice, PageHeader, SectionTitle, Select, Skeleton, cx,
} from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

const OPTIONAL_FEATURES: { key: keyof NonNullable<ReturnType<typeof useSession>["me"]>["capabilities"]; label: string }[] = [
  { key: "ai_analysis", label: "Local AI analysis (Ollama model)" },
  { key: "semantic_search", label: "Semantic search in the knowledge library" },
  { key: "ocr", label: "OCR for scanned PDFs" },
  { key: "email_delivery", label: "Email delivery of reminders" },
  { key: "calendar_sync", label: "Calendar sync" },
  { key: "push", label: "Push notifications" },
  { key: "code_execution", label: "Running code answers" },
  { key: "voice_interviews", label: "Voice interviews" },
];

function ThemeSection() {
  const [pref, setPref] = useState<ThemePref>("system");
  useEffect(() => setPref(getThemePref()), []);
  const opts: { id: ThemePref; label: string; icon: typeof Sun }[] = [
    { id: "system", label: "Match system", icon: Monitor },
    { id: "light", label: "Light", icon: Sun },
    { id: "dark", label: "Dark", icon: Moon },
  ];
  return (
    <section aria-labelledby="theme-h">
      <SectionTitle id="theme-h">Appearance</SectionTitle>
      <div role="radiogroup" aria-labelledby="theme-h" className="flex flex-wrap gap-2">
        {opts.map((o) => {
          const Icon = o.icon;
          const on = pref === o.id;
          return (
            <button key={o.id} type="button" role="radio" aria-checked={on} onClick={() => { setThemePref(o.id); setPref(o.id); }}
              className={cx("h-10 rounded-md border px-4 text-sm inline-flex items-center gap-2", on ? "border-accent bg-accent-soft" : "border-line-strong bg-surface hover:bg-surface-2")}>
              <Icon aria-hidden className="size-4" />{o.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[13px] text-muted">Saved in this browser.</p>
    </section>
  );
}

function TimezoneSection() {
  const { me, reloadMe } = useSession();
  const { notify } = useToast();
  const zones = useMemo(() => {
    try { return Intl.supportedValuesOf("timeZone"); } catch { return []; }
  }, []);
  const [tz, setTz] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => { if (me) setTz(me.user.timezone); }, [me]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await apiFetch<Profile>("profile");
      await apiFetch("profile", { method: "PUT", body: profilePayload(p, { timezone: tz }) });
      notify("ok", "Timezone saved");
      reloadMe();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const browserTz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";
  return (
    <section aria-labelledby="tz-h">
      <SectionTitle id="tz-h">Timezone</SectionTitle>
      {!me ? <Skeleton className="h-10 max-w-sm" /> : (
        <div className="flex flex-col gap-2 max-w-md">
          <Field label="Your timezone" hint="Used for date-only reminders (e.g. 9:00 on a given day)." error={error?.fields?.timezone}>
            {(p) => zones.length ? (
              <Select id={p.id} value={tz} onChange={(e) => setTz(e.target.value)} aria-describedby={p.describedBy}>
                {!zones.includes(tz) ? <option value={tz}>{tz}</option> : null}
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </Select>
            ) : <Input id={p.id} value={tz} onChange={(e) => setTz(e.target.value)} aria-describedby={p.describedBy} placeholder="e.g. Asia/Kolkata" />}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={busy} disabled={tz === me.user.timezone || !tz} onClick={save}>Save timezone</Button>
            {browserTz && browserTz !== tz ? <Button variant="ghost" onClick={() => setTz(browserTz)}>Use this device&apos;s ({browserTz})</Button> : null}
          </div>
          {error && !error.fields?.timezone ? <ErrorState error={error} title="Could not save" /> : null}
        </div>
      )}
    </section>
  );
}

function PasswordSection() {
  const { notify } = useToast();
  const router = useRouter();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 10) {
      setError(new ApiError({ status: 422, code: "validation_failed", message: "Use at least 10 characters.", fields: { new_password: "Use at least 10 characters." } }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch("auth/change-password", { method: "POST", body: { current_password: cur, new_password: next } });
      notify("ok", "Password changed. Please sign in again.");
      await sessionPost("logout").catch(() => null);
      router.replace("/login");
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="pw-h">
      <SectionTitle id="pw-h">Change password</SectionTitle>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2 max-w-xl" noValidate>
        <Field label="Current password" error={error?.fields?.current_password}>
          {(p) => <Input id={p.id} type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} aria-invalid={p.invalid} aria-describedby={p.describedBy} />}
        </Field>
        <Field label="New password" hint="At least 10 characters." error={error?.fields?.new_password}>
          {(p) => <Input id={p.id} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={p.invalid} aria-describedby={p.describedBy} />}
        </Field>
        {error && !Object.keys(error.fields).length ? <div className="sm:col-span-2"><ErrorState error={error} /></div> : null}
        <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" loading={busy} disabled={!cur || !next}>Change password</Button>
          <span className="text-[13px] text-muted">Other sessions, including the extension, are signed out.</span>
        </div>
      </form>
    </section>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { me } = useSession();
  const { notify } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [delOpen, setDelOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [pw, setPw] = useState("");
  const [delError, setDelError] = useState<ApiError | null>(null);

  const logoutAll = async () => {
    setBusy("all");
    try {
      await apiFetch("auth/logout-all", { method: "POST" });
      await sessionPost("logout").catch(() => null);
      router.replace("/login");
    } catch (e) {
      notify("error", (e as ApiError).message);
      setBusy(null);
    }
  };

  const exportData = async () => {
    setBusy("export");
    try {
      await downloadFile("account/export", "elevate-export.json");
      notify("ok", "Export downloaded");
    } catch (e) {
      notify("error", (e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  const deleteAccount = async () => {
    setBusy("delete");
    setDelError(null);
    try {
      await apiFetch("account/delete", { method: "POST", body: { password: pw, confirm } });
      await sessionPost("logout").catch(() => null);
      router.replace("/login");
    } catch (e) {
      setDelError(e as ApiError);
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Settings" description={me ? <>Signed in as <span className="font-medium text-ink">{me.user.email}</span></> : undefined} />
      <div className="flex flex-col gap-12">
        <ThemeSection />
        <TimezoneSection />

        <section aria-labelledby="ext-h">
          <SectionTitle id="ext-h">Browser extension</SectionTitle>
          <p className="text-sm text-ink-2 mb-3 max-w-2xl">Capture a job posting from the tab you are viewing, with one click.</p>
          <ButtonLink href="/extension/connect"><Plug aria-hidden className="size-4" />Connect browser extension</ButtonLink>
        </section>

        <section aria-labelledby="cap-h">
          <SectionTitle id="cap-h">Features in this installation</SectionTitle>
          {!me ? <Skeleton className="h-24 max-w-xl" /> : (
            <ul className="divide-y divide-line border-y border-line max-w-2xl">
              {OPTIONAL_FEATURES.map((f) => {
                const on = me.capabilities[f.key];
                return (
                  <li key={f.key} className="py-2.5 flex items-center gap-3 text-sm">
                    {on ? <CheckCircle2 aria-hidden className="size-4 text-ok" /> : <CircleSlash aria-hidden className="size-4 text-muted" />}
                    <span className="flex-1">{f.label}</span>
                    <span className={on ? "text-ok" : "text-muted"}>
                      {on ? "Available" : f.key === "ai_analysis" || f.key === "semantic_search" ? "Unavailable right now (local model not reachable or not installed)" : "Not available in this version"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-[13px] text-muted">Nothing is sent to external AI services. Supported language: English.</p>
        </section>

        <PasswordSection />

        <section aria-labelledby="sess-h">
          <SectionTitle id="sess-h">Sessions</SectionTitle>
          <p className="text-sm text-ink-2 mb-3">Sign out of every browser and the extension.</p>
          <Button loading={busy === "all"} onClick={logoutAll}>Sign out everywhere</Button>
        </section>

        <section aria-labelledby="data-h">
          <SectionTitle id="data-h">Your data</SectionTitle>
          <p className="text-sm text-ink-2 mb-3 max-w-2xl">Download everything your account owns as a JSON file. Uploaded resume files are listed with checksums and can be downloaded individually from Resumes.</p>
          <Button loading={busy === "export"} onClick={exportData}><Download aria-hidden className="size-4" />Export my data</Button>
        </section>

        <section aria-labelledby="del-h" className="rounded-lg border border-danger/40 p-4 max-w-2xl">
          <SectionTitle id="del-h">Delete account</SectionTitle>
          <p className="text-sm text-ink-2 mb-3">Permanently deletes your account, jobs, resumes and files, reports, plans, practice answers, notes and reminders. Running work is cancelled. This cannot be undone.</p>
          <Button variant="danger" onClick={() => { setDelOpen(true); setConfirm(""); setPw(""); setDelError(null); }}>Delete my account</Button>
        </section>
      </div>

      <Dialog open={delOpen} onClose={() => setDelOpen(false)} title="Delete your account permanently?"
        description="Export your data first if you want a copy."
        footer={<><Button onClick={() => setDelOpen(false)}>Cancel</Button>
          <Button variant="danger" loading={busy === "delete"} disabled={confirm !== "DELETE" || !pw} onClick={deleteAccount}>Delete account</Button></>}>
        <div className="flex flex-col gap-4">
          <Notice tone="danger">All records are deleted immediately and stored files are scheduled for removal. You will be signed out everywhere.</Notice>
          <Field label="Type DELETE to confirm" error={delError?.fields?.confirm}>
            {(p) => <Input id={p.id} value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} data-autofocus aria-invalid={p.invalid} aria-describedby={p.describedBy} />}
          </Field>
          <Field label="Your password" error={delError?.fields?.password}>
            {(p) => <Input id={p.id} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-invalid={p.invalid} aria-describedby={p.describedBy} />}
          </Field>
          {delError && !Object.keys(delError.fields).length ? <ErrorState error={delError} title="Could not delete the account" /> : null}
        </div>
      </Dialog>
    </>
  );
}
