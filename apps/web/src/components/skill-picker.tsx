"use client";

import { useEffect, useId, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { SkillHit } from "@/lib/types";
import { Input, cx } from "./ui/primitives";

/** Accessible combobox searching the skills taxonomy (GET /taxonomy/skills?q=). */
export function SkillPicker({ label, onPick, exclude = [], hint }: {
  label: string; onPick: (s: SkillHit) => void; exclude?: string[]; hint?: string;
}) {
  const id = useId();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SkillHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (!term) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    timer.current = setTimeout(() => {
      setStatus("loading");
      apiFetch<SkillHit[]>("taxonomy/skills", { query: { q: term.slice(0, 60) }, signal: ctrl.signal })
        .then((r) => {
          setHits(r.filter((h) => !exclude.includes(h.id)));
          setActive(0);
          setOpen(true);
          setStatus("idle");
        })
        .catch((e) => {
          if ((e as Error)?.name !== "AbortError") setStatus("error");
        });
    }, 200);
    return () => {
      ctrl.abort();
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const pick = (h: SkillHit) => {
    onPick(h);
    setQ("");
    setHits([]);
    setOpen(false);
  };

  const listId = `${id}-list`;
  return (
    <div className="relative flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <Input
        id={id}
        role="combobox"
        aria-expanded={open && hits.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && hits[active] ? `${id}-opt-${active}` : undefined}
        aria-describedby={`${id}-status`}
        value={q}
        placeholder="Search skills, e.g. SQL"
        autoComplete="off"
        onChange={(e) => setQ(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onFocus={() => hits.length && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, hits.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && open && hits[active]) { e.preventDefault(); pick(hits[active]); }
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      <p id={`${id}-status`} className="text-[13px] text-muted" aria-live="polite">
        {status === "loading" ? "Searching…" : status === "error" ? "Search failed. Try again." :
          q.trim() && !hits.length ? "No matching skills in the taxonomy." : hint || "Only skills from Elevate's taxonomy can be added."}
      </p>
      {open && hits.length ? (
        <ul id={listId} role="listbox" aria-label={`${label} suggestions`}
          className="absolute top-[68px] z-20 w-full max-h-64 overflow-auto rounded-md border border-line bg-surface shadow-lg py-1">
          {hits.map((h, i) => (
            <li key={h.id} id={`${id}-opt-${i}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(h); }}
              onMouseEnter={() => setActive(i)}
              className={cx("px-3 py-2 text-sm cursor-pointer flex justify-between gap-2", i === active ? "bg-surface-2" : "")}>
              <span>{h.label}</span>
              <span className="text-[12px] text-muted">{h.kind}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
