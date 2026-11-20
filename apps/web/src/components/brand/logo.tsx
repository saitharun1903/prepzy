/** Prepzy brand (option 07, "zap"): the wordmark "prep⚡y" with a gold lightning-bolt z. */
export function ZapWordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center font-bold lowercase tracking-[-0.045em] text-ink ${className}`} aria-hidden>
      prep
      <svg viewBox="0 0 30 46" className="h-[1.08em] w-[0.68em] shrink-0 -ml-[0.02em] -mr-[0.04em]" aria-hidden>
        <path d="M20 2L4 26h10l-4 18L26 18H16z" fill="#c9a24b" />
      </svg>
      y
    </span>
  );
}

/** App-icon tile: gold bolt on a glossy navy rounded square. */
export function ZapMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 64 64" className={`${className} drop-shadow-[0_4px_8px_rgba(15,29,51,0.35)]`}>
      <defs>
        <linearGradient id="zap-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2a4675" /><stop offset="1" stopColor="#0f1d33" /></linearGradient>
        <linearGradient id="zap-gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity="0.4" /><stop offset="0.55" stopColor="#fff" stopOpacity="0" /></linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#zap-bg)" />
      <rect width="64" height="64" rx="16" fill="url(#zap-gloss)" />
      <path d="M37 10L18 37h12l-4 17 20-28H34z" fill="#e4c26e" />
    </svg>
  );
}
