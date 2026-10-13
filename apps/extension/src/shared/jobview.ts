// Validated, size-bounded views of API responses used by the UI. Pure (unit-tested).
// Everything here is rendered with textContent only; nothing is ever inserted as HTML.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);
const arr = (v: unknown, max = 100): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

export const FIELD_ORDER = ["title", "company", "location", "work_mode", "employment_type", "seniority", "experience", "education", "salary", "deadline", "posted"] as const;
export type FieldName = (typeof FIELD_ORDER)[number];

export const FIELD_LABEL: Record<FieldName, string> = {
  title: "Title",
  company: "Company",
  location: "Location",
  work_mode: "Work mode",
  employment_type: "Employment type",
  seniority: "Seniority",
  experience: "Experience",
  education: "Education",
  salary: "Salary",
  deadline: "Deadline",
  posted: "Posted",
};

export interface FieldView {
  value: string | null;
  source: string;
  note: string | null;
  conflict: string | null;
}

export interface RequirementView {
  key: string;
  text: string;
  importance: "required" | "preferred" | "optional" | "unclear";
  /** labels of alternative concepts when the requirement is an either/or group ("A or B") */
  alternatives: string[] | null;
  concepts: string[];
  negated: boolean;
  notes: string[];
  /** "3+ yrs", "2–4 yrs" when the posting states an experience threshold */
  years: string | null;
}

export interface IssueView {
  code: string;
  section: string | null;
  message: string;
}

export interface AnalysisView {
  id: string;
  status: string;
  model: string | null;
  promptVersion: string | null;
  schemaVersion: string | null;
  createdAt: string | null;
  isLatest: boolean;
  stale: boolean;
  fields: Record<FieldName, FieldView>;
  requirements: RequirementView[];
  issues: IssueView[];
}

export interface JobView {
  job: { id: string; title: string | null; company: string | null; sourceUrl: string | null; saved: boolean };
  analysis: AnalysisView | null;
  historyCount: number;
  activeOperations: number;
}

function fieldView(v: unknown): FieldView {
  const f = obj(v);
  if (!f) return { value: null, source: "unknown", note: null, conflict: null };
  let value = str(f.value, 300);
  if (value === null && obj(f.structured)) {
    const s = obj(f.structured)!;
    const parts = [s.currency, s.min ?? s.value, s.max].filter((x) => typeof x === "string" || typeof x === "number");
    if (parts.length) value = parts.join(" ").slice(0, 120) + (typeof s.period === "string" ? ` / ${s.period.slice(0, 20)}` : "");
  }
  const conflict = obj(f.conflict) ? str(obj(f.conflict)!.structured_data, 300) : null;
  return { value, source: str(f.source, 40) ?? "unknown", note: str(f.note, 300), conflict };
}

const IMPORTANCE = new Set(["required", "preferred", "optional", "unclear"]);

export function requirementView(v: unknown): RequirementView | null {
  const r = obj(v);
  if (!r) return null;
  const text = str(r.text, 1000);
  const key = str(r.key, 120);
  if (!text || !key) return null;
  const imp = typeof r.importance === "string" && IMPORTANCE.has(r.importance) ? (r.importance as RequirementView["importance"]) : "unclear";
  const concepts = arr(r.concepts, 20)
    .map((c) => str(obj(c)?.label, 80))
    .filter((x): x is string => x !== null);
  const alternatives = r.group === "any" && concepts.length >= 2 ? concepts : null;
  return {
    key,
    text,
    importance: imp,
    alternatives,
    concepts,
    negated: r.negated === true,
    years: yearsText(r.years),
    notes: arr(r.notes, 5).map((n) => str(n, 300)).filter((x): x is string => x !== null),
  };
}

function yearsText(v: unknown): string | null {
  const y = obj(v);
  if (!y || typeof y.min !== "number") return null;
  return typeof y.max === "number" && y.max > y.min ? `${y.min}–${y.max} yrs` : `${y.min}+ yrs`;
}

/** "A or B or C" for either/or requirement groups. */
export function alternativesText(alts: string[] | null): string | null {
  return alts && alts.length >= 2 ? alts.join(" or ") : null;
}

export function splitRequirements(reqs: RequirementView[]): { required: RequirementView[]; preferred: RequirementView[]; unclear: RequirementView[] } {
  return {
    required: reqs.filter((r) => r.importance === "required"),
    preferred: reqs.filter((r) => r.importance === "preferred" || r.importance === "optional"),
    unclear: reqs.filter((r) => r.importance === "unclear"),
  };
}

export function toJobView(json: unknown): JobView | null {
  const root = obj(json);
  const job = obj(root?.job);
  const id = str(job?.id, 64);
  if (!root || !job || !id) return null;
  let analysis: AnalysisView | null = null;
  const a = obj(root.analysis);
  if (a && str(a.id, 64)) {
    const result = obj(a.result) ?? {};
    const fieldsIn = obj(result.fields) ?? {};
    const fields = {} as Record<FieldName, FieldView>;
    for (const k of FIELD_ORDER) fields[k] = fieldView(fieldsIn[k]);
    analysis = {
      id: str(a.id, 64)!,
      status: str(a.status, 40) ?? "unknown",
      model: str(a.model, 120),
      promptVersion: str(a.prompt_version, 60),
      schemaVersion: str(a.schema_version, 60),
      createdAt: str(a.created_at, 60),
      isLatest: a.is_latest !== false,
      stale: a.stale === true,
      fields,
      requirements: arr(result.requirements, 80).map(requirementView).filter((x): x is RequirementView => x !== null),
      issues: arr(a.issues, 30)
        .map((i) => {
          const o = obj(i);
          const message = str(o?.message, 600);
          return o && message ? { code: str(o.code, 60) ?? "issue", section: str(o.section, 60), message } : null;
        })
        .filter((x): x is IssueView => x !== null),
    };
  }
  return {
    job: {
      id,
      title: str(job.title, 300),
      company: str(job.company, 300),
      sourceUrl: str(job.source_url, 4000),
      saved: job.saved === true,
    },
    analysis,
    historyCount: arr(root.history, 1000).length,
    activeOperations: arr(root.active_operations, 100).length,
  };
}

export interface LookupView {
  id: string;
  title: string | null;
  company: string | null;
  saved: boolean;
  latestAnalysisId: string | null;
}

export function toLookupView(json: unknown): LookupView | null {
  const j = obj(obj(json)?.job);
  const id = str(j?.id, 64);
  if (!j || !id) return null;
  return { id, title: str(j.title, 300), company: str(j.company, 300), saved: j.saved === true, latestAnalysisId: str(j.latest_analysis_id, 64) };
}

export interface ApplicationView {
  id: string;
  status: string;
  version: number;
}

export function toApplicationView(json: unknown): ApplicationView | null {
  const o = obj(json);
  const id = str(o?.id, 64);
  const status = str(o?.status, 40);
  if (!o || !id || !status || typeof o.version !== "number") return null;
  return { id, status, version: o.version };
}

// ---------------------------------------------------------------- match report (fit summary)

export type FitStatus = "supported" | "user_confirmed" | "partial" | "adjacent" | "not_evidenced" | "not_met_confirmed" | "unassessable";
const FIT = new Set<FitStatus>(["supported", "user_confirmed", "partial", "adjacent", "not_evidenced", "not_met_confirmed", "unassessable"]);

export interface FitGroup {
  coverage: number | null;
  total: number;
  met: number;
}

export interface MatchView {
  reportId: string;
  scoreStatus: "available" | "withheld";
  withheldReason: string | null;
  required: FitGroup;
  preferred: FitGroup;
  /** requirement key -> fit status */
  status: Record<string, FitStatus>;
  /** concept labels the job asks for that your evidence does not show (required first) */
  missing: string[];
  hasResume: boolean;
  stale: boolean;
}

function fitGroup(v: unknown): FitGroup {
  const g = obj(v) ?? {};
  const counts = obj(g.counts) ?? {};
  const n = (k: string) => (typeof counts[k] === "number" ? (counts[k] as number) : 0);
  return {
    coverage: typeof g.coverage === "number" && isFinite(g.coverage) ? Math.max(0, Math.min(100, g.coverage)) : null,
    total: typeof g.total === "number" ? g.total : 0,
    met: n("supported") + n("user_confirmed"),
  };
}

export function toMatchView(json: unknown): MatchView | null {
  const root = obj(json);
  const result = obj(root?.result);
  const id = str(root?.id, 64);
  if (!root || !result || !id) return null;
  const summary = obj(result.summary) ?? {};
  const status: Record<string, FitStatus> = {};
  for (const u of arr(result.requirements, 120)) {
    const o = obj(u);
    const key = str(o?.key, 120);
    const s = o?.status;
    if (key && typeof s === "string" && FIT.has(s as FitStatus)) status[key] = s as FitStatus;
  }
  const missing = arr(result.priorities, 40)
    .map((p) => str(obj(p)?.label, 80))
    .filter((x): x is string => x !== null);
  return {
    reportId: id,
    scoreStatus: summary.score_status === "available" ? "available" : "withheld",
    withheldReason: str(summary.withheld_reason, 300),
    required: fitGroup(summary.required),
    preferred: fitGroup(summary.preferred),
    status,
    missing: Array.from(new Set(missing)).slice(0, 12),
    hasResume: obj(result.resume) !== null,
    stale: arr(root.stale_reasons, 10).length > 0,
  };
}

/** Short, scannable label for a requirement: "Java or Kotlin · 3+ yrs", "Spring Boot + REST APIs". */
export function shortLabel(r: RequirementView): string {
  const years = r.years;
  let base: string;
  if (r.alternatives) base = r.alternatives.join(" or ");
  else if (r.concepts.length) base = r.concepts.slice(0, 3).join(" + ") + (r.concepts.length > 3 ? " …" : "");
  else base = r.text.length > 70 ? `${r.text.slice(0, 67).trimEnd()}…` : r.text;
  return years ? `${base} · ${years}` : base;
}
