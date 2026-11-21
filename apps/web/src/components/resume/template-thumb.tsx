import type { LatexStyle } from "@/lib/resume-templates";

/** Small visual thumbnail so people can pick a template by eye. */
export function TemplateThumb({ id, className = "h-28 w-auto" }: { id: LatexStyle; className?: string }) {
  const accent = id === "classic" ? "#4f7ea0" : id === "modern" ? "#1b2f52" : "#111";
  const left = id === "modern";
  return (
    <svg viewBox="0 0 120 150" className={`${className} rounded-md bg-white ring-1 ring-black/10 shrink-0`} aria-hidden>
      <rect x={left ? 12 : 30} y="14" width="60" height="8" rx="2" fill={accent} />
      {id === "modern" ? <rect x="12" y="26" width="34" height="4" rx="2" fill="#c9a24b" /> : null}
      <rect x={left ? 12 : 22} y={id === "modern" ? 34 : 28} width="76" height="3" rx="1.5" fill="#9aa3b2" />
      {(id === "compact" ? [40, 66, 92, 118] : [48, 82, 112]).map((y, k) => (
        <g key={k}>
          <rect x="12" y={y} width="34" height="4" rx="1" fill={accent} />
          <rect x="12" y={y + 6} width="96" height={id === "modern" && k === 0 ? 1.5 : 1} fill={id === "modern" ? "#c9a24b" : "#333"} />
          <rect x="14" y={y + 11} width="90" height="2.4" rx="1" fill="#c7ccd6" />
          <rect x="14" y={y + 16} width="80" height="2.4" rx="1" fill="#c7ccd6" />
          <rect x="14" y={y + 21} width="86" height="2.4" rx="1" fill="#c7ccd6" />
        </g>
      ))}
    </svg>
  );
}

