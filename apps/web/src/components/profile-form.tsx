"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { CAREER_STAGES, WORK_MODES, todayISO } from "@/lib/format";
import type { Domain, Profile } from "@/lib/types";
import {
  Button, Checkbox, ChipsInput, ErrorState, Field, Input, LoadingBlock, Notice, Select, ToggleGroup,
} from "./ui/primitives";
import { useToast } from "./ui/toast";
import { HOSTED, AI_PROVIDER } from "@/lib/hosting";

type Draft = {
  career_stage: string; target_roles: string[]; domains: string[]; locations: string[]; work_modes: string[];
  weekly_hours: string; target_date: string; headline: string; consent: boolean;
};

function toDraft(p: Profile): Draft {
  return {
    career_stage: p.career_stage || "", target_roles: p.target_roles || [], domains: p.domains || [],
    locations: p.locations || [], work_modes: p.work_modes || [], weekly_hours: p.weekly_hours ? String(p.weekly_hours) : "",
    target_date: p.target_date || "", headline: p.headline || "", consent: Boolean(p.consent_processing_at),
  };
}

export function profilePayload(p: Profile, overrides: Record<string, unknown> = {}) {
  return {
    expected_revision: p.revision, career_stage: p.career_stage, target_roles: p.target_roles, domains: p.domains,
    locations: p.locations, work_modes: p.work_modes, weekly_hours: p.weekly_hours, target_date: p.target_date,
    headline: p.headline, ...overrides,
  };
}

export function ProfileForm({ mode }: { mode: "onboarding" | "profile" }) {
  const router = useRouter();
  const { notify } = useToast();
  const prof = useApi<Profile>("profile");
  const doms = useApi<{ version: string; domains: Domain[] }>("taxonomy/domains");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [revision, setRevision] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [conflict, setConflict] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (prof.data && !dirty) {
      setDraft(toDraft(prof.data));
      setRevision(prof.data.revision);
    }
  }, [prof.data, dirty]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
    setDirty(true);
  };

  const save = async (opts: { skip?: boolean; rev?: number } = {}) => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      const hours = draft.weekly_hours ? Number(draft.weekly_hours) : null;
      const body = opts.skip && mode === "onboarding" && prof.data
        ? profilePayload(prof.data, { complete_onboarding: true })
        : {
          expected_revision: opts.rev ?? revision,
          career_stage: draft.career_stage || null,
          target_roles: draft.target_roles,
          domains: draft.domains,
          locations: draft.locations,
          work_modes: draft.work_modes,
          weekly_hours: hours && Number.isFinite(hours) ? Math.round(hours) : null,
          target_date: draft.target_date || null,
          headline: draft.headline.trim() || null,
          consent_processing: draft.consent,
          complete_onboarding: mode === "onboarding",
        };
      const p = await apiFetch<Profile>("profile", { method: "PUT", body });
      setRevision(p.revision);
      setDirty(false);
      prof.setData(p);
      notify("ok", mode === "onboarding" ? "Setup saved" : "Profile saved");
      if (mode === "onboarding") router.push("/");
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "stale_write") setConflict(true);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };

  const keepMine = async () => {
    try {
      const latest = await apiFetch<Profile>("profile");
      await save({ rev: latest.revision });
    } catch (e) {
      setError(e as ApiError);
    }
  };

  const discardMine = () => {
    setDirty(false);
    setConflict(false);
    prof.reload();
  };

  if (prof.loading && !draft) return <LoadingBlock label="Loading profile" />;
  if (prof.error) return <ErrorState error={prof.error} onRetry={prof.reload} title="Could not load your profile" />;
  if (!draft) return null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-8" noValidate>
      {conflict ? (
        <Notice tone="warn" title="Your profile was changed in another tab or device">
          <p>Your edits below are kept. Choose whether to save them over the newer version, or discard them and load the latest.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={keepMine} loading={busy}>Save my changes anyway</Button>
            <Button size="sm" onClick={discardMine}>Discard mine and reload</Button>
          </div>
        </Notice>
      ) : null}

      <section className="grid gap-6 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <ChipsInput label="Target roles" values={draft.target_roles} onChange={(v) => set("target_roles", v)}
            placeholder="e.g. Data analyst" hint="The kinds of jobs you are preparing for." />
        </div>
        <Field label="Career stage" error={error?.fields?.career_stage}>
          {(p) => (
            <Select id={p.id} value={draft.career_stage} onChange={(e) => set("career_stage", e.target.value)} aria-describedby={p.describedBy}>
              <option value="">Not specified</option>
              {CAREER_STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Headline (optional)" hint="A short line about you, for your own reference.">
          {(p) => <Input id={p.id} value={draft.headline} maxLength={200} onChange={(e) => set("headline", e.target.value)} aria-describedby={p.describedBy} />}
        </Field>
      </section>

      <section>
        <fieldset>
          <legend className="text-sm font-medium mb-1">Domains</legend>
          <p className="text-[13px] text-muted mb-2">Used to choose relevant interview question types and starter plans.</p>
          {doms.error ? <ErrorState error={doms.error} onRetry={doms.reload} title="Could not load domains" /> : null}
          {doms.loading ? <LoadingBlock rows={1} label="Loading domains" /> : null}
          <div className="flex flex-wrap gap-2">
            {doms.data?.domains.map((d) => {
              const on = draft.domains.includes(d.id);
              return (
                <label key={d.id} className={`inline-flex items-center gap-2 h-9 rounded-full border px-3.5 text-sm cursor-pointer ${on ? "border-accent bg-accent-soft" : "border-line-strong bg-surface hover:bg-surface-2"}`}>
                  <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={on}
                    onChange={() => set("domains", on ? draft.domains.filter((x) => x !== d.id) : [...draft.domains, d.id].slice(0, 10))} />
                  {d.label}
                </label>
              );
            })}
          </div>
        </fieldset>
      </section>

      <section className="grid gap-6 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <ChipsInput label="Preferred locations" values={draft.locations} onChange={(v) => set("locations", v)} placeholder="e.g. Bengaluru" />
        </div>
        <div className="sm:col-span-2">
          <ToggleGroup label="Work modes" options={WORK_MODES} values={draft.work_modes} onChange={(v) => set("work_modes", v)} />
        </div>
        <Field label="Weekly study hours" hint="Used to schedule preparation plans (1–80)." error={error?.fields?.weekly_hours}>
          {(p) => (
            <Input id={p.id} type="number" inputMode="numeric" min={1} max={80} value={draft.weekly_hours}
              onChange={(e) => set("weekly_hours", e.target.value)} aria-describedby={p.describedBy} aria-invalid={p.invalid} />
          )}
        </Field>
        <Field label="Target date (optional)" hint="When you would like to be ready." error={error?.fields?.target_date}>
          {(p) => (
            <Input id={p.id} type="date" min={todayISO()} value={draft.target_date} onChange={(e) => set("target_date", e.target.value)}
              aria-describedby={p.describedBy} aria-invalid={p.invalid} />
          )}
        </Field>
      </section>

      <section className="rounded-lg border border-line bg-surface p-4">
        <Checkbox
          checked={draft.consent}
          onChange={(e) => set("consent", e.target.checked)}
          label={HOSTED ? "I agree to Elevate processing my career data" : "I agree to Elevate processing my career data on this machine"}
          hint={HOSTED ? `Job postings, resumes and answers are stored in your private account and analysed by ${AI_PROVIDER}, which states it does not train on this data.` : "Job postings, resumes and answers are analysed by a local Ollama model and stored in a local PostgreSQL database. Nothing is sent to external AI services."}
        />
      </section>

      {error && !Object.keys(error.fields).length ? <ErrorState error={error} title="Could not save" /> : null}

      <div className="flex flex-wrap gap-2 border-t border-line pt-6">
        <Button type="submit" variant="primary" loading={busy}>{mode === "onboarding" ? "Save and continue" : "Save profile"}</Button>
        {mode === "onboarding" ? (
          <Button variant="ghost" onClick={() => save({ skip: true })} disabled={busy}>Skip for now</Button>
        ) : dirty ? <span className="self-center text-[13px] text-muted" aria-live="polite">Unsaved changes</span> : null}
      </div>
    </form>
  );
}
