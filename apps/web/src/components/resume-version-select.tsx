"use client";

import { useEffect } from "react";
import { useApi } from "@/lib/hooks";
import { formatDate } from "@/lib/format";
import type { Resume } from "@/lib/types";
import { ButtonLink, ErrorState, Field, Select, Skeleton } from "./ui/primitives";

export type VersionPick = { resumeId: string; versionId: string } | null;

/** Pick a parsed resume version. Defaults to the latest parsed version of the default resume. */
export function ResumeVersionSelect({ value, onChange, label = "Resume version", allowNone, noneLabel = "None", autoSelect }: {
  value: VersionPick; onChange: (v: VersionPick) => void; label?: string; allowNone?: boolean; noneLabel?: string;
  /** Preselect the default resume's latest parsed version (defaults to true unless allowNone). */
  autoSelect?: boolean;
}) {
  const auto = autoSelect ?? !allowNone;
  const resumes = useApi<Resume[]>("resumes");
  const parsed = (resumes.data || []).map((r) => ({ ...r, versions: r.versions.filter((v) => v.parse_status === "parsed") }))
    .filter((r) => r.versions.length);

  useEffect(() => {
    if (value || !auto || !parsed.length) return;
    const def = parsed.find((r) => r.is_default) || parsed[0];
    onChange({ resumeId: def.id, versionId: def.versions[0].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumes.data]);

  if (resumes.loading && !resumes.data) return <Skeleton className="h-10 w-full max-w-md" />;
  if (resumes.error) return <ErrorState error={resumes.error} onRetry={resumes.reload} title="Could not load resumes" />;
  if (!parsed.length) {
    return (
      <div className="text-sm text-ink-2 flex flex-wrap items-center gap-2">
        No parsed resume versions yet.
        <ButtonLink href="/resumes" size="sm">Add a resume</ButtonLink>
      </div>
    );
  }
  return (
    <Field label={label}>
      {(p) => (
        <Select id={p.id} className="max-w-md" value={value?.versionId || ""}
          onChange={(e) => {
            const vid = e.target.value;
            if (!vid) return onChange(null);
            const r = parsed.find((x) => x.versions.some((v) => v.id === vid));
            onChange(r ? { resumeId: r.id, versionId: vid } : null);
          }}>
          {allowNone ? <option value="">{noneLabel}</option> : null}
          {parsed.map((r) => (
            <optgroup key={r.id} label={`${r.name}${r.is_default ? " (default)" : ""}`}>
              {r.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  Version {v.version} · {v.origin === "upload" ? v.original_filename || "upload" : v.origin} · {formatDate(v.created_at)}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      )}
    </Field>
  );
}
