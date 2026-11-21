"use client";

import Link from "next/link";
import { ZapMark, ZapWordmark } from "@/components/brand/logo";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  Bell, Briefcase, CalendarCheck, FileCode2, FileText, Gauge, Home, LogOut, MailWarning, Menu, MessagesSquare, Puzzle, Route, Settings, ShieldCheck, UserRound, X,
} from "lucide-react";
import { sessionPost } from "@/lib/api";
import { ResendVerification, cx } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/dialog";
import { SessionProvider, useSession } from "./session";

type NavItem = { href: string; label: string; short?: string; icon: typeof Home; badge?: "unread"; step?: number; group: "main" | "steps" | "account" };
// Ordered as the user's journey: add evidence, analyze a job, prepare, practise, apply.
const NAV: NavItem[] = [
  { href: "/", label: "Home", icon: Home, group: "main" },
  { href: "/resume-builder", label: "Resume builder", icon: FileCode2, group: "main" },
  { href: "/ats", label: "ATS checker", icon: Gauge, group: "main" },
  { href: "/resumes", label: "My resume", short: "Resume", icon: FileText, step: 1, group: "steps" },
  { href: "/jobs", label: "Jobs & match", short: "Jobs", icon: Briefcase, step: 2, group: "steps" },
  { href: "/preparation", label: "Study plan", short: "Plan", icon: Route, step: 3, group: "steps" },
  { href: "/interviews", label: "Practice interviews", short: "Practice", icon: MessagesSquare, step: 4, group: "steps" },
  { href: "/applications", label: "Applications", short: "Apply", icon: CalendarCheck, step: 5, group: "steps" },
  { href: "/extension/connect", label: "Browser extension", icon: Puzzle, group: "account" },
  { href: "/profile", label: "Career profile", icon: UserRound, group: "account" },
  { href: "/notifications", label: "Notifications", icon: Bell, badge: "unread", group: "account" },
  { href: "/settings", label: "Settings", icon: Settings, group: "account" },
];
const BOTTOM = ["/", "/resumes", "/jobs", "/interviews"];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function Wordmark() {
  return (
    <Link href="/" className="inline-flex items-center gap-2 text-ink" aria-label="Prepzy home">
      <ZapMark className="size-7" />
      <ZapWordmark className="text-[22px]" />
    </Link>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { unread, me } = useSession();
  const item = (n: NavItem) => {
    const active = isActive(pathname, n.href);
    const Icon = n.icon;
    return (
      <li key={n.href}>
        <Link
          href={n.href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className={cx(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] transition-colors",
            active ? "bg-white text-accent font-medium shadow-[0_1px_2px_rgba(17,24,39,0.06),0_6px_16px_-8px_rgba(15,29,51,0.35)] ring-1 ring-accent/15" : "text-ink-2 hover:bg-white/70 hover:text-ink",
          )}
        >
          {n.step ? (
            <span aria-hidden className={cx("grid place-items-center size-5 rounded-full text-[11px] font-semibold",
              active ? "icon-chip-solid" : "bg-white text-muted border border-line shadow-[inset_0_1px_0_#fff]")}>{n.step}</span>
          ) : (
            <span aria-hidden className={cx("grid place-items-center size-5", active ? "text-accent" : "text-muted")}><Icon className="size-4" /></span>
          )}
          <span className="flex-1">{n.step ? <span className="sr-only">Step {n.step}: </span> : null}{n.label}</span>
          {n.badge === "unread" && unread > 0 ? (
            <span className="rounded-full bg-accent text-accent-ink text-[11px] font-semibold px-1.5 min-w-5 text-center">
              {unread}
              <span className="sr-only"> unread</span>
            </span>
          ) : null}
        </Link>
      </li>
    );
  };
  return (
    <ul className="flex flex-col gap-0.5">
      {NAV.filter((n) => n.group === "main").map(item)}
      <li aria-hidden className="mt-4 mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted">Your steps</li>
      {NAV.filter((n) => n.group === "steps").map(item)}
      <li aria-hidden className="mt-4 mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted">Account</li>
      {NAV.filter((n) => n.group === "account").map(item)}
      {me?.user.is_admin ? (
        <li>
          <Link href="/admin/knowledge" onClick={onNavigate} aria-current={isActive(pathname, "/admin") ? "page" : undefined}
            className={cx("flex items-center gap-3 rounded-md px-3 py-2 text-[14px]",
              isActive(pathname, "/admin") ? "bg-surface-2 text-ink font-medium" : "text-ink-2 hover:bg-surface-2 hover:text-ink")}>
            <ShieldCheck aria-hidden className="size-4 text-muted" />
            <span>Admin · Knowledge</span>
          </Link>
        </li>
      ) : null}
    </ul>
  );
}

function SignOut({ className }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await sessionPost("logout");
        } finally {
          router.replace("/login");
          router.refresh();
        }
      }}
      className={cx("flex items-center gap-3 rounded-md px-3 py-2 text-[14px] text-ink-2 hover:bg-surface-2 hover:text-ink w-full", className)}
    >
      <LogOut aria-hidden className="size-4 text-muted" />
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}

const VERIFY_BANNER_KEY = "el_verify_banner_dismissed";

/** Slim banner while the deployment requires a confirmed email and this account has not confirmed it.
 * Dismissal lasts for this browser tab session only. */
function VerifyEmailBanner() {
  const { me } = useSession();
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(VERIFY_BANNER_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);
  if (!me || dismissed || !me.account_security?.require_verified_email || me.user.email_verified !== false) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(VERIFY_BANNER_KEY, "1");
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <div role="region" aria-label="Email confirmation" className="mb-6 rounded-md border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-sm flex items-start gap-2.5">
      <MailWarning aria-hidden className="size-4 mt-0.5 shrink-0 text-warn" />
      <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-ink">
          <span className="font-medium">Confirm your email to use AI analysis.</span>{" "}
          {me.account_security.email_delivery ? <span className="text-ink-2 break-all">Look for the link we sent to {me.user.email}.</span> : null}
        </p>
        <ResendVerification deliveryConfigured={me.account_security.email_delivery} />
      </div>
      <button type="button" onClick={dismiss} aria-label="Dismiss email confirmation reminder" className="rounded p-0.5 text-muted hover:text-ink">
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // The LaTeX editor needs the full width for code + preview side by side.
  const wide = /^\/resume-builder\/[^/]+/.test(pathname);
  const [drawer, setDrawer] = useState(false);
  const { me, unread } = useSession();
  useEffect(() => setDrawer(false), [pathname]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      <a href="#main" className="sr-only-focusable fixed left-3 top-3 z-[70] rounded-md bg-surface px-3 py-2 border border-line">Skip to content</a>

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:flex-col sticky top-0 h-dvh border-r border-line glass px-4 py-6">
        <div className="px-2 mb-8"><Wordmark /></div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto"><NavList /></nav>
        <div className="border-t border-line pt-3 mt-3">
          {me ? <p className="px-3 pb-2 text-[12px] text-muted truncate" title={me.user.email}>{me.user.email}</p> : null}
          <SignOut />
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="lg:hidden sticky top-0 z-40 flex items-center justify-between border-b border-line bg-bg/95 backdrop-blur-sm px-4 h-14">
        <Wordmark />
        <div className="flex items-center gap-1">
          <Link href="/notifications" className="relative rounded-md p-2 text-ink-2 hover:bg-surface-2" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
            <Bell aria-hidden className="size-5" />
            {unread > 0 ? <span aria-hidden className="absolute -top-0.5 -right-0.5 rounded-full bg-accent text-accent-ink text-[10px] font-semibold px-1 min-w-4 text-center">{unread}</span> : null}
          </Link>
          <button type="button" onClick={() => setDrawer(true)} className="rounded-md p-2 text-ink-2 hover:bg-surface-2" aria-label="Open navigation menu" aria-expanded={drawer}>
            <Menu aria-hidden className="size-5" />
          </button>
        </div>
      </div>

      <Dialog open={drawer} onClose={() => setDrawer(false)} title="Menu">
        <nav aria-label="Main"><NavList onNavigate={() => setDrawer(false)} /></nav>
        <div className="border-t border-line mt-3 pt-3">
          {me ? <p className="px-3 pb-2 text-[12px] text-muted truncate">{me.user.email}</p> : null}
          <SignOut />
        </div>
      </Dialog>

      <main id="main" tabIndex={-1} className={cx("min-w-0 px-4 sm:px-8 pt-6 pb-28 lg:pb-16 focus:outline-none",
        wide ? "lg:px-6 sm:pt-6" : "lg:px-12 sm:pt-10")}>
        <div className={cx("mx-auto", wide ? "max-w-none" : "max-w-[1080px]")}>
          <VerifyEmailBanner />
          {children}
        </div>
      </main>

      {/* Mobile bottom nav */}
      <nav aria-label="Quick" className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-line bg-bg/95 backdrop-blur-sm pb-[env(safe-area-inset-bottom)]">
        <ul className="grid grid-cols-5">
          {NAV.filter((n) => BOTTOM.includes(n.href)).map((n) => {
            const active = isActive(pathname, n.href);
            const Icon = n.icon;
            return (
              <li key={n.href}>
                <Link href={n.href} aria-current={active ? "page" : undefined}
                  className={cx("flex flex-col items-center gap-0.5 py-2 text-[11px]", active ? "text-accent font-medium" : "text-muted")}>
                  <Icon aria-hidden className="size-5" />
                  {n.short ?? n.label}
                </Link>
              </li>
            );
          })}
          <li>
            <button type="button" onClick={() => setDrawer(true)} className="w-full flex flex-col items-center gap-0.5 py-2 text-[11px] text-muted" aria-expanded={drawer}>
              {drawer ? <X aria-hidden className="size-5" /> : <Menu aria-hidden className="size-5" />}
              More
            </button>
          </li>
        </ul>
      </nav>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
