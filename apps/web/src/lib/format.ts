export function humanize(s: string | null | undefined): string {
  if (!s) return "";
  const t = s.replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function formatDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
  if (!iso) return "—";
  // Date-only strings are calendar dates: format without timezone shifting.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, opts);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "";
  const diff = (d - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return formatDate(iso);
}

export function formatBytes(n: number | null | undefined): string {
  if (!n && n !== 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function months(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const y = Math.floor(n / 12);
  const m = n % 12;
  return [y ? `${y} yr` : "", m ? `${m} mo` : "", !y && !m ? "0 mo" : ""].filter(Boolean).join(" ");
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const CAREER_STAGES: { id: string; label: string }[] = [
  { id: "student", label: "Student" },
  { id: "fresh_graduate", label: "Fresh graduate" },
  { id: "early_career", label: "Early career" },
  { id: "mid_career", label: "Mid career" },
  { id: "senior", label: "Senior" },
  { id: "career_changer", label: "Career changer" },
];

export const WORK_MODES = [
  { id: "remote", label: "Remote" },
  { id: "hybrid", label: "Hybrid" },
  { id: "onsite", label: "On-site" },
];

export const EVIDENCE_TYPES = [
  { id: "self_reported", label: "Self-reported" },
  { id: "project", label: "Project" },
  { id: "course", label: "Course" },
  { id: "professional", label: "Professional work" },
  { id: "certification", label: "Certification" },
];

export const APP_STATUSES = ["planned", "applied", "screening", "interviewing", "offer", "rejected", "withdrawn", "closed"] as const;

export function jobTitle(j: { title?: string | null; company?: string | null } | null | undefined): string {
  if (!j) return "Untitled job";
  return j.title || "Untitled job";
}
