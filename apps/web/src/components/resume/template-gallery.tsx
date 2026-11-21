"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { LATEX_TEMPLATE_LIST } from "@/lib/resume-templates";
import { cx } from "@/components/ui/primitives";

const CATS = ["All", "Classic", "Modern", "Minimal", "Executive"] as const;

/** Real thumbnails rendered from each template's compiled PDF (public/templates/<id>.png). */
export function TemplateGallery({ selected, onPick, busyId, columns = "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" }: {
  selected?: string | null; onPick: (id: string) => void; busyId?: string | null; columns?: string;
}) {
  const [cat, setCat] = useState<(typeof CATS)[number]>("All");
  const list = LATEX_TEMPLATE_LIST.filter((t) => cat === "All" || t.category === cat);
  return (
    <div>
      <div role="group" aria-label="Filter templates" className="flex flex-wrap gap-2 mb-4">
        {CATS.map((c) => (
          <button key={c} type="button" aria-pressed={cat === c} onClick={() => setCat(c)}
            className={cx("h-8 rounded-full border px-3 text-sm transition", cat === c ? "border-accent bg-accent-soft text-ink" : "border-line-strong text-ink-2 hover:text-ink")}>
            {c}{c === "All" ? ` (${LATEX_TEMPLATE_LIST.length})` : ""}
          </button>
        ))}
      </div>
      <div className={cx("grid gap-4", columns)}>
        {list.map((t) => {
          const on = selected === t.id;
          return (
            <button key={t.id} type="button" disabled={Boolean(busyId)} onClick={() => onPick(t.id)} aria-pressed={on}
              className={cx("group text-left rounded-2xl border bg-surface p-3 flex flex-col gap-2.5 transition disabled:opacity-60",
                on ? "border-accent ring-2 ring-accent/25" : "border-line hover:border-accent/50 hover:shadow-[0_14px_36px_-24px_rgba(15,29,51,0.6)]")}>
              <span className="relative block overflow-hidden rounded-lg bg-white ring-1 ring-black/10 aspect-[4/3]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/templates/${t.id}.png`} alt={`${t.label} resume template preview`} loading="lazy"
                  className="absolute inset-x-0 top-0 w-full transition-transform duration-300 group-hover:scale-[1.03] origin-top" />
                {on ? <span className="absolute right-2 top-2 grid place-items-center size-6 rounded-full bg-accent text-white shadow"><Check aria-hidden className="size-4" /></span> : null}
              </span>
              <span className="flex items-center justify-between gap-2">
                <span className="font-semibold text-ink">{t.label}</span>
                <span className="text-[11.5px] rounded-full bg-surface-2 px-2 py-0.5 text-ink-2">{t.category}</span>
              </span>
              <span className="text-[12.5px] text-ink-2 -mt-1">{busyId === t.id ? "Creating…" : t.tagline}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
