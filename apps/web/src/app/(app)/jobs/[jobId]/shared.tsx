"use client";

import { useId, useState } from "react";
import { ChevronDown, Quote } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { FieldSource } from "@/lib/types";
import { Badge, cx } from "@/components/ui/primitives";

export const FIELD_LABELS: Record<string, string> = {
  title: "Title", company: "Company", location: "Location", work_mode: "Work mode", employment_type: "Employment type",
  seniority: "Seniority", experience: "Experience", education: "Education", salary: "Salary", deadline: "Application deadline",
  posted: "Posted",
};

export const CATEGORIES = ["skill", "experience", "education", "certification", "location", "work_arrangement", "language", "other"];
export const IMPORTANCES = ["required", "preferred", "optional", "unclear"];

export function SourceBadge({ source }: { source: FieldSource | string }) {
  if (source === "job_text") return <Badge tone="ok">From posting text</Badge>;
  if (source === "structured_data") return <Badge tone="warn">Page metadata (unverified)</Badge>;
  if (source === "user_correction") return <Badge tone="info">Your correction</Badge>;
  return <Badge>Unknown</Badge>;
}

/** Evidence quote, revealed with a button (keyboard and touch friendly), with a hover title for mouse users. */
export function EvidenceToggle({ quote, label = "Show evidence" }: { quote: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="mt-1">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} title={quote}
        className="inline-flex items-center gap-1 text-[13px] text-accent hover:underline underline-offset-4">
        <Quote aria-hidden className="size-3.5" />{open ? "Hide evidence" : label}
        <ChevronDown aria-hidden className={cx("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      <blockquote id={id} hidden={!open} className="mt-1.5 border-l-2 border-accent pl-3 text-sm text-ink-2 prewrap">
        {quote}
      </blockquote>
    </div>
  );
}

export function addCorrection(jobId: string, body: { analysis_id: string; target: string; key: string; value: Record<string, unknown>; note?: string | null }) {
  return apiFetch<{ id: string }>(`jobs/${jobId}/corrections`, { method: "POST", body });
}

export function revertCorrection(jobId: string, correctionId: string) {
  return apiFetch(`jobs/${jobId}/corrections/${correctionId}`, { method: "DELETE" });
}
