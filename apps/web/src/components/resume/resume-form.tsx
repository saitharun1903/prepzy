"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { TailoredEntry, TailoredResume } from "@/lib/resume-templates";

/** Simple form over the structured resume. Every change rebuilds the LaTeX, so students never touch code.
 * Tip shown to users: wrap words in **double asterisks** to make them bold. */

const input = "w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-[13.5px] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/15";
const label = "block text-[12px] font-medium text-ink-2 mb-1";

function Text({ l, value, onChange, placeholder, wide }: { l: string; value: string | null; onChange: (v: string) => void; placeholder?: string; wide?: boolean }) {
  return (
    <label className={wide ? "sm:col-span-2" : undefined}>
      <span className={label}>{l}</span>
      <input className={input} value={value ?? ""} placeholder={placeholder} maxLength={300} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Lines({ l, value, onChange, rows = 3, hint }: { l: string; value: string[]; onChange: (v: string[]) => void; rows?: number; hint?: string }) {
  return (
    <label className="sm:col-span-2">
      <span className={label}>{l}{hint ? <span className="font-normal text-muted"> — {hint}</span> : null}</span>
      <textarea className={input + " resize-y leading-relaxed"} rows={rows} value={value.join("\n")} maxLength={4000}
        onChange={(e) => onChange(e.target.value.split("\n"))} onBlur={(e) => onChange(e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))} />
    </label>
  );
}

function Section({ title, children, onAdd, addLabel }: { title: string; children: ReactNode; onAdd?: () => void; addLabel?: string }) {
  return (
    <section className="border-b border-line pb-5 mb-5 last:border-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-ink">{title}</h3>
        {onAdd ? <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline"><Plus aria-hidden className="size-3.5" />{addLabel}</button> : null}
      </div>
      {children}
    </section>
  );
}

function ItemShell({ i, n, onMove, onRemove, children }: { i: number; n: number; onMove: (d: -1 | 1) => void; onRemove: () => void; children: ReactNode }) {
  return (
    <div className="relative rounded-xl border border-line bg-surface-2/50 p-3 mb-3">
      <div className="absolute right-2 top-2 flex gap-0.5">
        <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => onMove(-1)} className="p-1 rounded text-muted hover:text-ink disabled:opacity-30"><ArrowUp aria-hidden className="size-3.5" /></button>
        <button type="button" aria-label="Move down" disabled={i === n - 1} onClick={() => onMove(1)} className="p-1 rounded text-muted hover:text-ink disabled:opacity-30"><ArrowDown aria-hidden className="size-3.5" /></button>
        <button type="button" aria-label="Remove" onClick={onRemove} className="p-1 rounded text-muted hover:text-danger"><Trash2 aria-hidden className="size-3.5" /></button>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2 pr-20">{children}</div>
    </div>
  );
}

function move<T>(arr: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  const out = arr.slice();
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

const emptyEntry = (): TailoredEntry => ({ title: "", org: null, link: null, tech: null, location: null, dates: null, bullets: [] });

export function ResumeForm({ value, onChange }: { value: TailoredResume; onChange: (v: TailoredResume) => void }) {
  const r = value;
  const set = <K extends keyof TailoredResume>(k: K, v: TailoredResume[K]) => onChange({ ...r, [k]: v });
  const setContact = (k: keyof TailoredResume["contact"], v: string) => set("contact", { ...r.contact, [k]: v || null });
  const entries = (key: "experience" | "projects", titleLabel: string, orgLabel: string) => (
    r[key].map((e, i) => {
      const upd = (patch: Partial<TailoredEntry>) => set(key, r[key].map((x, j) => (j === i ? { ...x, ...patch } : x)));
      return (
        <ItemShell key={i} i={i} n={r[key].length} onMove={(d) => set(key, move(r[key], i, d))} onRemove={() => set(key, r[key].filter((_, j) => j !== i))}>
          <Text l={titleLabel} value={e.title} onChange={(v) => upd({ title: v })} />
          <Text l={orgLabel} value={key === "projects" ? e.link : e.org} onChange={(v) => upd(key === "projects" ? { link: v || null } : { org: v || null })} />
          <Text l="Dates" value={e.dates} placeholder="Jun 2025 -- Aug 2025" onChange={(v) => upd({ dates: v || null })} />
          <Text l="Technologies" value={e.tech} placeholder="React, Node.js" onChange={(v) => upd({ tech: v || null })} />
          <Lines l="Bullet points" hint="one per line" rows={3} value={e.bullets} onChange={(v) => upd({ bullets: v })} />
        </ItemShell>
      );
    })
  );

  return (
    <div className="p-4 text-sm">
      <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-[12.5px] text-ink-2">
        Type in the boxes and the PDF updates. Make words bold with <code className="font-mono">**double asterisks**</code>.
      </p>

      <Section title="Your details">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <Text l="Full name" value={r.name} onChange={(v) => set("name", v)} />
          <Text l="Headline (optional)" value={r.headline} placeholder="Software Engineer" onChange={(v) => set("headline", v || null)} />
          <Text l="Phone" value={r.contact.phone} onChange={(v) => setContact("phone", v)} />
          <Text l="Email" value={r.contact.email} onChange={(v) => setContact("email", v)} />
          <Text l="LinkedIn" value={r.contact.linkedin} placeholder="linkedin.com/in/…" onChange={(v) => setContact("linkedin", v)} />
          <Text l="GitHub" value={r.contact.github} placeholder="github.com/…" onChange={(v) => setContact("github", v)} />
          <Text l="Website" value={r.contact.website} onChange={(v) => setContact("website", v)} />
          <Text l="Location" value={r.contact.location} onChange={(v) => setContact("location", v)} />
        </div>
      </Section>

      <Section title="Professional summary">
        <textarea className={input + " resize-y leading-relaxed"} rows={3} maxLength={1200} value={r.summary ?? ""}
          onChange={(e) => set("summary", e.target.value || null)} aria-label="Professional summary" />
      </Section>

      <Section title="Education" onAdd={() => set("education", [...r.education, { school: "", degree: null, location: null, dates: null, score: null }])} addLabel="Add education">
        {r.education.map((e, i) => {
          const upd = (patch: Partial<typeof e>) => set("education", r.education.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <ItemShell key={i} i={i} n={r.education.length} onMove={(d) => set("education", move(r.education, i, d))} onRemove={() => set("education", r.education.filter((_, j) => j !== i))}>
              <Text l="School / university" value={e.school} onChange={(v) => upd({ school: v })} />
              <Text l="Degree" value={e.degree} onChange={(v) => upd({ degree: v || null })} />
              <Text l="Score" value={e.score} placeholder="CGPA: 9.0" onChange={(v) => upd({ score: v || null })} />
              <Text l="Location" value={e.location} onChange={(v) => upd({ location: v || null })} />
              <Text l="Dates" value={e.dates} placeholder="2023 -- 2027" onChange={(v) => upd({ dates: v || null })} />
            </ItemShell>
          );
        })}
      </Section>

      <Section title="Skills" onAdd={() => set("skills", [...r.skills, { group: "", items: [] }])} addLabel="Add group">
        {r.skills.map((g, i) => (
          <ItemShell key={i} i={i} n={r.skills.length} onMove={(d) => set("skills", move(r.skills, i, d))} onRemove={() => set("skills", r.skills.filter((_, j) => j !== i))}>
            <Text l="Group" value={g.group} placeholder="Languages" onChange={(v) => set("skills", r.skills.map((x, j) => (j === i ? { ...x, group: v } : x)))} />
            <label>
              <span className={label}>Skills <span className="font-normal text-muted">— comma separated</span></span>
              <input className={input} defaultValue={g.items.join(", ")} key={g.items.join("|")}
                onBlur={(e) => set("skills", r.skills.map((x, j) => (j === i ? { ...x, items: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : x)))} />
            </label>
          </ItemShell>
        ))}
      </Section>

      <Section title="Experience" onAdd={() => set("experience", [...r.experience, emptyEntry()])} addLabel="Add experience">
        {entries("experience", "Role", "Company")}
      </Section>

      <Section title="Projects" onAdd={() => set("projects", [...r.projects, emptyEntry()])} addLabel="Add project">
        {entries("projects", "Project name", "Link")}
      </Section>

      <Section title="Achievements & certifications">
        <div className="grid"><Lines l="One per line" rows={3} value={r.achievements} onChange={(v) => set("achievements", v)} /></div>
      </Section>
    </div>
  );
}
