import type { Metadata } from "next";
import { BookOpenCheck, Briefcase, CalendarCheck, FileSearch, MessagesSquare, ShieldCheck } from "lucide-react";
import { ButtonLink } from "@/components/ui/primitives";
import { DATA_PROMISE } from "@/lib/hosting";

export const metadata: Metadata = {
  title: "Prepare for the jobs you want",
  description: "See which requirements of a job posting your own evidence covers, close the gaps, practise interviews and track applications.",
};

const STEPS = [
  { icon: Briefcase, title: "Capture a job", body: "Paste a posting, or click the browser extension on any job page." },
  { icon: FileSearch, title: "See what it asks for", body: "Required and preferred skills, experience, education and deadline, each quoted from the posting." },
  { icon: BookOpenCheck, title: "Compare with your resume", body: "Every requirement is marked covered, partly covered or missing, with the line from your resume that proves it." },
  { icon: MessagesSquare, title: "Prepare and practise", body: "A study plan that fits your weekly hours, and practice interview questions focused on your gaps." },
  { icon: CalendarCheck, title: "Track applications", body: "Statuses, notes and reminders for every job, so nothing slips." },
];

const PRINCIPLES = [
  ["No fake hiring scores", "Prepzy never predicts whether you will be hired. It measures how much of the posting your evidence covers, and says so when it can't tell."],
  ["Nothing invented", "Every requirement is quoted from the real posting. Resume suggestions can't add skills or numbers you don't have."],
  ["You stay in control", "Correct any result, export everything, or delete your account at any time."],
] as const;

export default function WelcomePage() {
  return (
    <div className="mx-auto w-full max-w-5xl flex flex-col gap-16">
      <section className="flex flex-col items-start gap-5 max-w-3xl">
        <p className="inline-flex items-center gap-2 rounded-full border border-gold/40 bg-white/70 px-3 py-1 text-[13px] font-medium text-gold-ink shadow-sm"><span className="size-1.5 rounded-full bg-gold" />Evidence-based career preparation</p>
        <h1 className="serif text-4xl sm:text-[56px] leading-[1.08] tracking-tight">Know exactly where you stand for <span className="text-brand">every job you apply to.</span></h1>
        <p className="text-lg text-ink-2">
          Prepzy turns a job posting into a clear checklist of what you already have and what you&apos;re missing,
          then helps you close the gaps, practise interviews and keep track of your applications.
        </p>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href="/register" variant="primary" className="h-11 px-5">Create a free account</ButtonLink>
          <ButtonLink href="/login" className="h-11 px-5">Sign in</ButtonLink>
        </div>
        <p className="text-sm text-muted inline-flex items-center gap-1.5"><ShieldCheck aria-hidden className="size-4" />{DATA_PROMISE}</p>
      </section>

      <section aria-labelledby="how">
        <h2 id="how" className="serif text-2xl mb-6">How it works</h2>
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-xl border border-line bg-surface surface-premium lift p-5 flex flex-col gap-3">
              <span className="flex items-center justify-between"><span aria-hidden className="icon-chip size-10"><s.icon className="size-5" /></span><span className="text-xs font-medium text-muted">Step {i + 1}</span></span>
              <h3 className="font-medium">{s.title}</h3>
              <p className="text-sm text-ink-2">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="why" className="grid gap-6 sm:grid-cols-3">
        <h2 id="why" className="sr-only">Why Prepzy</h2>
        {PRINCIPLES.map(([t, b]) => (
          <div key={t} className="flex flex-col gap-1.5 rounded-xl border border-line/70 bg-white/60 p-5">
            <h3 className="font-medium">{t}</h3>
            <p className="text-sm text-ink-2">{b}</p>
          </div>
        ))}
      </section>

      <section className="relative overflow-hidden rounded-2xl p-6 sm:p-10 flex flex-col sm:flex-row sm:items-center justify-between gap-4 panel-midnight">
        <div>
          <h2 className="serif text-2xl">Ready for your next application?</h2>
          <p className="text-white/85 mt-1">It takes about two minutes: add your resume, paste a job, see your match.</p>
        </div>
        <ButtonLink href="/register" variant="ghost" className="h-11 px-6 btn-gold !text-[#1a1408] !border-transparent font-semibold">Get started</ButtonLink>
      </section>
    </div>
  );
}
