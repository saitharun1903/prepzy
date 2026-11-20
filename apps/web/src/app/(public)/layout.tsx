import Link from "next/link";
import { ZapMark, ZapWordmark } from "@/components/brand/logo";
import { HOSTED, AI_PROVIDER } from "@/lib/hosting";

export const dynamic = "force-dynamic";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="sticky top-0 z-30 glass px-4 sm:px-8 h-16 flex items-center justify-between border-b border-line">
        <Link href="/" className="inline-flex items-center gap-2 text-ink" aria-label="Prepzy">
          <ZapMark className="size-7" />
      <ZapWordmark className="text-[22px]" />
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
