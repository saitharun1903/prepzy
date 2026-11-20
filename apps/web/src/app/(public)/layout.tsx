import Link from "next/link";
import { HOSTED, AI_PROVIDER } from "@/lib/hosting";

export const dynamic = "force-dynamic";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="sticky top-0 z-30 glass px-4 sm:px-8 h-16 flex items-center justify-between border-b border-line">
        <Link href="/" className="inline-flex items-center gap-2 text-ink" aria-label="Prepzy">
          <svg aria-hidden viewBox="0 0 32 32" className="size-7 drop-shadow-[0_4px_8px_rgba(15,29,51,0.35)]">
            <defs>
              <linearGradient id="el-logo-pub" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2a4675" /><stop offset="1" stopColor="#0f1d33" /></linearGradient>
              <linearGradient id="el-gloss-pub" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity="0.45" /><stop offset="0.55" stopColor="#fff" stopOpacity="0" /></linearGradient>
            </defs>
            <rect width="32" height="32" rx="9" fill="url(#el-logo-pub)" />
            <rect width="32" height="32" rx="9" fill="url(#el-gloss-pub)" />
            <path d="M11.5 23.5V8.5h7a4.75 4.75 0 0 1 0 9.5h-7" stroke="#e4c77d" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="serif text-xl tracking-tight">Prepzy</span>
        </Link>
        <nav aria-label="Public" className="flex gap-4 text-sm text-ink-2">
          <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          <Link href="/login" className="hover:text-ink">Sign in</Link>
        </nav>
      </header>
      <main id="main" className="flex-1 px-4 sm:px-8 py-10 sm:py-16">{children}</main>
      <footer className="px-4 sm:px-8 py-6 text-[13px] text-muted border-t border-line">
        {HOSTED ? `AI analysis is processed by ${AI_PROVIDER}. You can export or delete your data at any time.` : "Prepzy runs on this machine. AI analysis uses a local model; nothing is sent to external AI services."}
      </footer>
    </div>
  );
}
