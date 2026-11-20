"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { EVIDENCE_TYPES, formatDate } from "@/lib/format";
import type { Fact, SkillHit } from "@/lib/types";
import { SkillPicker } from "@/components/skill-picker";
import { Badge, Button, EmptyState, ErrorState, Field, LoadingBlock, Notice, SectionTitle, Select, Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";

export function ConfirmedSkills() {
  const facts = useApi<Fact[]>("profile/facts");
  const { notify } = useToast();
  const [skill, setSkill] = useState<SkillHit | null>(null);
  const [evidence, setEvidence] = useState("self_reported");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const add = async () => {
    if (!skill) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("profile/facts", { method: "POST", body: { kind: "skill", concept_id: skill.id, evidence_type: evidence, detail: detail.trim() || null } });
      notify("ok", `Added ${skill.label}`);
      setSkill(null);
      setDetail("");
      setEvidence("self_reported");
      facts.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (f: Fact) => {
    setRemoving(f.id);
    try {
      await apiFetch(`profile/facts/${f.id}`, { method: "DELETE" });
      notify("ok", `Removed ${f.label}`);
      facts.reload();
    } catch (e) {
      notify("error", (e as ApiError).message);
    } finally {
      setRemoving(null);
    }
  };

  const skills = (facts.data || []).filter((f) => f.kind === "skill");
  const label = (id: string) => EVIDENCE_TYPES.find((t) => t.id === id)?.label || id;

  return (
    <section aria-labelledby="confirmed-skills">
      <SectionTitle id="confirmed-skills">Confirmed skills</SectionTitle>
      <Notice tone="info" className="mb-5">
        <strong className="font-medium text-ink">Self-reported</strong> means you are telling Prepzy you have the skill, without
        something to show for it. <strong className="font-medium text-ink">Evidenced</strong> types (project, course, professional
        work, certification) say where the skill comes from — add a short detail so you can back it up. Both count towards job
        comparisons and are labelled as coming from your profile, not your resume.
      </Notice>

      <div className="grid gap-4 sm:grid-cols-[1fr_220px] items-start rounded-lg border border-line bg-surface p-4">
        <SkillPicker label="Skill" onPick={setSkill} exclude={skills.map((s) => s.concept_id || "")} />
        <Field label="Evidence type">
          {(p) => (
            <Select id={p.id} value={evidence} onChange={(e) => setEvidence(e.target.value)}>
              {EVIDENCE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </Select>
          )}
        </Field>
        <div className="sm:col-span-2">
          <Field label="Detail (optional)" hint="For example the project name or course you took.">
            {(p) => <Textarea id={p.id} rows={2} maxLength={2000} value={detail} onChange={(e) => setDetail(e.target.value)} aria-describedby={p.describedBy} />}
          </Field>
        </div>
        <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={add} disabled={!skill} loading={busy}>
            {skill ? `Add ${skill.label}` : "Choose a skill to add"}
          </Button>
          {skill ? <Button variant="ghost" onClick={() => setSkill(null)}>Clear</Button> : null}
        </div>
        {error ? <div className="sm:col-span-2"><ErrorState error={error} title="Could not add the skill" /></div> : null}
      </div>

      <div className="mt-6">
        {facts.loading && !facts.data ? <LoadingBlock rows={2} label="Loading skills" /> : null}
        {facts.error ? <ErrorState error={facts.error} onRetry={facts.reload} /> : null}
        {facts.data && !skills.length ? (
          <EmptyState title="No confirmed skills yet">Skills found in your resume are listed on each resume version. Add skills here that your resume does not show.</EmptyState>
        ) : null}
        {skills.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {skills.map((f) => (
              <li key={f.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{f.label}</span>
                    <Badge tone={f.evidence_type === "self_reported" ? "neutral" : "accent"}>{label(f.evidence_type)}</Badge>
                  </div>
                  {f.detail ? <p className="text-sm text-ink-2 mt-1 break-words">{f.detail}</p> : null}
                  <p className="text-[12px] text-muted mt-1">Added {formatDate(f.created_at)}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => remove(f)} loading={removing === f.id} aria-label={`Remove ${f.label}`}>
                  <Trash2 aria-hidden className="size-4" /> Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
