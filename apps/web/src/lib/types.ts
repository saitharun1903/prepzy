/** Response shapes for API endpoints that return untyped dicts (read from services/api routers). */
import type { components } from "@elevate/api-client";

export type JobSummary = components["schemas"]["JobSummary"];

export type OpState =
  | "queued" | "running" | "partially_succeeded" | "succeeded" | "failed" | "timed_out" | "cancellation_requested" | "cancelled";

export type Operation<R = Record<string, unknown>> = {
  id: string; kind: string; state: OpState; stage: string | null; attempt: number; max_attempts: number;
  cancel_requested: boolean; error: { code: string; message: string; retryable?: boolean } | null;
  result: R | null; created_at: string; started_at: string | null; finished_at: string | null; deadline_at: string | null;
  terminal: boolean;
};

export type Accepted = { operation_id: string; status_url: string };

export type User = {
  id: string; email: string; display_name: string | null; is_admin: boolean; timezone: string; created_at?: string;
  email_verified?: boolean; mfa_enabled?: boolean;
};

export type Me = {
  user: User;
  capabilities: {
    ai_analysis: boolean; semantic_search: boolean; ocr: boolean; email_delivery: boolean; calendar_sync: boolean;
    push: boolean; code_execution: boolean; voice_interviews: boolean; external_ai: boolean;
  };
  limits: { max_upload_mb: number; max_job_text_chars: number; supported_resume_formats: string[]; supported_languages: string[] };
  account_security?: { require_verified_email: boolean; email_delivery: boolean };
};

export type MfaStatus = { enabled: boolean; recovery_codes_left: number };
export type MfaSetup = { secret: string; otpauth_uri: string; qr_svg: string };

export type Profile = {
  revision: number; career_stage: string | null; target_roles: string[]; domains: string[]; locations: string[];
  work_modes: string[]; weekly_hours: number | null; target_date: string | null; headline: string | null;
  onboarded_at: string | null; consent_processing_at: string | null; updated_at: string | null;
  display_name: string | null; timezone: string;
};

export type Domain = {
  id: string; label: string; skills: number; interview_kinds: string[]; knowledge_chunks: number;
  evaluation: { status: string; cases: number };
};

export type SkillHit = { id: string; label: string; kind: string };

export type Fact = {
  id: string; kind: string; concept_id: string | null; label: string; evidence_type: string; detail: string | null; created_at: string;
};

// ---------------------------------------------------------------- jobs
export type FieldSource = "job_text" | "structured_data" | "user_correction" | "page" | "unknown";
export type AnalysisField = {
  value: string | null; source: FieldSource; evidence: { quote: string; start: number; end: number } | null;
  note?: string; conflict?: { structured_data: string }; original?: { value: string | null; source: string };
  correction_id?: string; kind?: string; structured?: unknown;
};
export type Concept = { id: string; label: string };
export type Requirement = {
  key: string; text: string; span: number[] | null; category: string; importance: string; concepts: Concept[];
  group: "single" | "any" | "all"; years: { min?: number; max?: number | null; unit?: string; original: string; ambiguous?: boolean } | null;
  negated: boolean; method: string; review: string; notes: string[]; removed_by_user?: boolean;
  original?: { importance: string; category: string; concepts: Concept[]; group: string };
  correction_id?: string; user_confirmation?: { met: boolean; note: string | null; correction_id: string };
};
export type AnalysisResult = {
  fields: Record<string, AnalysisField>;
  requirements: Requirement[];
  responsibilities: { text: string; span: number[] }[];
  domains: { id: string; label: string; weight: number }[];
  skills_mentioned: { id: string; label: string; count: number }[];
  language: { detected: string; supported: boolean; reason?: string; mixed?: boolean };
  claims: Record<string, unknown>;
};
export type AnalysisMeta = {
  id: string; status: string; created_at: string; model: string; prompt_version: string; schema_version: string;
  taxonomy_version: string; snapshot_id: string; duration_ms: number | null; issue_count: number;
};
export type JobDetail = {
  job: {
    id: string; title: string | null; company: string | null; source_url: string | null; saved: boolean; saved_at: string | null;
    created_at: string; availability: "unknown" | "last_observed" | "closed"; last_observed_at: string | null;
  };
  snapshots: { id: string; version: number; capture_method: string; captured_at: string; source_url: string | null;
    page_title: string | null; extraction_version: string; chars: number }[];
  latest_snapshot_text: string | null;
  analysis: (AnalysisMeta & { issues: { code: string; section?: string; message: string }[]; result: AnalysisResult;
    is_latest: boolean; stale: boolean }) | null;
  corrections: { id: string; target: string; key: string; value: Record<string, unknown>; note: string | null; created_at: string }[];
  history: AnalysisMeta[];
  active_operations: Operation[];
};
export type CaptureOut = {
  job_id: string; snapshot_id: string; operation_id: string | null; analysis_id: string | null; reused_analysis: boolean;
  new_job: boolean; status_url: string | null;
};

// ---------------------------------------------------------------- matching
export type MatchStatus = "supported" | "user_confirmed" | "partial" | "adjacent" | "not_evidenced" | "not_met_confirmed" | "unassessable";
export type Evidence = { concept_id?: string; label: string; type: string; source: string; excerpt?: string | null };
export type MatchUnit = {
  key: string; text: string; importance: string; category: string; group: string; concepts: Concept[];
  years: Requirement["years"]; evidence: Evidence[]; adjacent: { concept_id: string; label: string; for: string; rule: string }[];
  missing: Concept[]; notes: string[]; status: MatchStatus; credit: number; assessed_weight: number; rule: string | null;
};
export type CoverageSummary = {
  total: number; assessable: number; completeness: number | null; coverage: number | null; counts: Record<string, number>;
};
export type MatchResult = {
  scoring_version: string; label: string; disclaimer: string;
  summary: { required: CoverageSummary; preferred: CoverageSummary; unclear: CoverageSummary; score_status: "available" | "withheld"; withheld_reason: string | null };
  requirements: MatchUnit[];
  conditions: (Omit<MatchUnit, "evidence" | "status"> & { user_confirmation: Requirement["user_confirmation"] | null; note: string })[];
  excluded: { key: string; text: string; importance: string; reason: string }[];
  priorities: { concept_id: string; label: string; importance: string; requirement_key: string; adjacent: boolean; priority: string }[];
  evidence_basis: { resume_skills: number; profile_skills: number; experience_months: number | null; education_level_detected: number | null };
  resume: { version_id: string; resume_id: string; version: number } | null;
  inputs: { analysis_id: string; resume_version_id: string | null; profile_revision: number; corrections_rev: string; taxonomy_version: string; scoring_version: string };
};
export type MatchReport = { id: string; job_id: string; created_at: string; result: MatchResult; stale_reasons: string[]; reused?: boolean };

// ---------------------------------------------------------------- resumes
export type ResumeVersionMeta = {
  id: string; version: number; origin: string; original_filename: string | null; mime: string | null; size_bytes: number | null;
  parse_status: string; parse_error: string | null; reviewed_at: string | null; created_at: string; has_file: boolean; skill_count: number;
};
export type Resume = { id: string; name: string; is_default: boolean; created_at: string; versions: ResumeVersionMeta[] };
export type ExtractedSkill = { id: string; label: string; spans: number[][]; sections: string[]; evidence_type: string; mentions: number };
export type Extracted = {
  parser_version: string; taxonomy_version: string; sections: { name: string; heading: string; start: number; end: number }[];
  skills: ExtractedSkill[];
  experience: { line: string; start: string; end: string; span: number[]; issue?: string }[];
  experience_months: number | null;
  education: { text: string; span: number[] }[];
  certifications: { text: string; span: number[] }[];
  projects: { text: string; span: number[] }[];
  contact: { email_present: boolean; phone_present: boolean };
  warnings: string[];
};
export type Reviewed = { removed_skills: string[]; added_skills: { id: string; evidence_type?: string }[]; experience_months_override: number | null };
export type AtsFinding = { id: string; severity: string; category: string; message: string; why: string; skills?: string[] };
export type ResumeVersionDetail = {
  resume: { id: string; name: string; is_default: boolean };
  version: ResumeVersionMeta & { text: string | null; extracted: Extracted | null; reviewed: Reviewed | null;
    effective_skills: { id: string; label: string; evidence_type: string; source: string; spans: number[][] }[] };
  ats_findings: AtsFinding[];
};
export type Suggestion = { original: string; span: number[]; suggested: string; reason: string; needs_evidence: string | null };
export type SuggestResult = { version_id: string; suggestions: Suggestion[]; rejected_count: number; rejected: { original?: string; reason: string }[]; model: string; note: string };

// ---------------------------------------------------------------- applications
export type AppStatus = "planned" | "applied" | "screening" | "interviewing" | "offer" | "rejected" | "withdrawn" | "closed";
export type Application = {
  id: string; job_id: string; cycle: number; status: AppStatus; applied_on: string | null; resume_version_id: string | null;
  next_action: string | null; next_action_on: string | null; version: number; created_at: string; updated_at: string;
  job?: { id: string; title: string | null; company: string | null; source_url: string | null };
  history?: { id: string; from: string | null; to: string; note: string | null; is_correction: boolean; at: string }[];
};
export type ApplicationPage = { items: Application[]; next_cursor: string | null; total: number; counts: Record<string, number>; status_help: Record<string, string> };
export type Note = { id: string; job_id: string; body: string; version: number; created_at: string; updated_at: string };
export type Reminder = {
  id: string; title: string; job_id: string | null; application_id: string | null; due_at: string; due_date: string | null;
  timezone: string; status: string; processed_at: string | null; late_by_seconds: number | null; created_at: string; note?: string | null;
};
export type Notification = {
  id: string; kind: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null; dismissed_at: string | null;
};

// ---------------------------------------------------------------- interviews
export type InterviewSessionSummary = {
  id: string; title: string; job_id: string | null; status: string; config: Record<string, unknown>; created_at: string;
  completed_at: string | null; questions: number; answered: number;
};
export type Evaluation = {
  assessable: boolean; reason?: string;
  criteria: { criterion: string; rating: "met" | "partly" | "not_met" | "cannot_assess"; answer_quote: string | null; comment: string }[];
  strengths: string[]; gaps: string[]; improvements: string[]; tally: Record<string, number>; model?: string; method: string;
};
export type InterviewAnswer = {
  id: string; revision: number; answer: string; started_at: string | null; submitted_at: string | null; eval_status: string; evaluation: Evaluation | null;
};
export type InterviewQuestion = {
  id: string; ord: number; kind: string; kind_label: string; topic: string; prompt: string;
  rubric: { criterion: string; origin: string }[]; rubric_version: string; origin: string; requirement_ref: string | null;
  status: "pending" | "answered" | "skipped"; answers: InterviewAnswer[];
};
export type InterviewSession = {
  id: string; title: string; job_id: string | null; status: string;
  config: { kinds?: string[]; topics?: string[]; difficulty?: string; count?: number; mode?: string; minutes?: number | null; operation_id?: string; domains?: string[] };
  created_at: string; completed_at: string | null; questions: InterviewQuestion[];
};

// ---------------------------------------------------------------- roadmaps
export type Resource = { kind: string; source_id?: string; title: string; url: string | null; review_state: string; visibility?: string; provenance?: string };
export type RoadmapTask = {
  id: string; key: string; ord: number; title: string; objective: string | null; skill_id: string | null; requirement_ref: string | null;
  priority: string; est_hours_low: number; est_hours_high: number; depends_on: string[]; resources: Resource[];
  scheduled_week: number | null; status: "todo" | "in_progress" | "done" | "skipped"; user_edited: boolean; completed_at: string | null; version: number;
};
export type Feasibility = {
  weekly_hours: number; total_hours_low: number; total_hours_high: number; weeks_needed: number; estimated_finish: string;
  feasible: boolean; available_weeks?: number; suggestions?: string[]; cycles?: unknown[];
};
export type Roadmap = {
  id: string; title: string; job_id: string | null; status: "active" | "paused" | "archived"; weekly_hours: number;
  start_date: string; target_date: string | null; feasibility: Feasibility; generic: boolean; revision: number;
  created_at: string; updated_at: string; progress: { done: number; total: number }; planner_version: string;
  tasks: RoadmapTask[]; history: { kind: string; detail: Record<string, unknown>; at: string }[];
};
export type RoadmapSummary = {
  id: string; title: string; status: string; job_id: string | null; generic: boolean; progress: { done: number; total: number };
  feasible: boolean | null; updated_at: string;
};
export type RegenDiff = {
  based_on_revision: number; match_report_id: string | null;
  diff: { keep: { key: string; title: string; reason: string }[]; add: { key: string; title: string; priority: string }[];
    remove: { key: string; title: string }[]; update: { key: string; title: string; changes: Record<string, unknown> }[] };
};

// ---------------------------------------------------------------- knowledge
export type KnowledgeSource = {
  id: string; title: string; visibility: string; source_type: string; source_url: string | null; domain: string | null; skills: string[];
  language: string; license_basis: string; published_on: string | null; review_state: string; review_note: string | null;
  active_version_id: string | null; created_at: string;
  versions?: { id: string; version: number; status: string; error: string | null; chunk_count: number | null; embed_model: string;
    retrieved_at: string | null; activated_at: string | null; checksum: string }[];
};

export type QAResult = {
  job_id: string; question: string; answer: string; sufficient_evidence: boolean;
  citations: { source: "job_posting" | "knowledge"; excerpt: string; title?: string; source_url?: string | null; review_state?: string; snapshot_id?: string }[];
  problems: string[]; model: string; note: string | null;
  guidance?: string;
};
