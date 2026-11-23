import type { Metadata } from "next";
import { FileCode2, Gauge, MessagesSquare, Puzzle, ShieldCheck, Target, Wand2 } from "lucide-react";
import { ButtonLink } from "@/components/ui/primitives";
import { DATA_PROMISE } from "@/lib/hosting";

export const metadata: Metadata = {
  title: "Land the job, not the ATS bin",
  description: "Job match, ATS score with a one-click fix, a full apply kit and LaTeX resumes, built only from your real resume.",
};

const FEATURES = [
  { icon: Target, title: "Your match for any job", body: "Every requirement marked covered, partly there or missing, quoted from the posting and your resume." },
  { icon: Wand2, title: "Apply kit in one click", body: "Tailored resume PDF, cover letter, cold email, referral request and LinkedIn note. Nothing invented." },
  { icon: Gauge, title: "ATS score + one-click fix", body: "See how Workday, Taleo, Greenhouse and others read your resume, then add the right keywords honestly." },
  { icon: FileCode2, title: "LaTeX resume builder", body: "16 professional templates, live PDF preview, fill a form or edit the code — like Overleaf, made simple." },
  { icon: MessagesSquare, title: "Interview practice", body: "Likely questions for the role, feedback on your answers, and links to real interview experiences." },
  { icon: Puzzle, title: "Chrome extension", body: "Click the Prepzy icon on LinkedIn or any careers page — the job is captured and analysed for you." },
];

const SHOWCASE = [
  { img: "/landing/ats.webp", title: "Beat the ATS before you apply", body: "Scored for the system the company uses. Tap the skills you really have and get a clean, one-page PDF back — your words, the job's keywords." },
  { img: "/landing/apply-kit.webp", title: "Everything you need to apply", body: "A cover letter, cold email and referral message that sound like you, fact-checked line by line against your resume." },
  { img: "/landing/builder.webp", title: "Resumes recruiters can read", body: "Pick a professional LaTeX template, edit with a simple form or the code, and download a PDF that fills the page." },
];

const PRINCIPLES = [
  ["Nothing invented", "Anything the AI writes that isn't backed by your resume is removed before you see it."],
  ["No fake hiring scores", "Prepzy measures how much of the posting your evidence covers — it never claims to predict a hire."],
  ["You stay in control", "Correct any result, export everything, or delete your account at any time."],
] as const;

export default function WelcomePage() {
  return (
    <div className="mx-auto w-full max-w-6xl flex flex-col gap-20 overflow-x-clip">
      <section className="grid gap-10 lg:grid-cols-[1.05fr_1fr] lg:items-center">
        <div className="flex flex-col items-start gap-5">
          <p className="inline-flex items-center gap-2 rounded-full border border-gold/40 bg-white/70 px-3 py-1 text-[13px] font-medium text-gold-ink shadow-sm">
            <span className="size-1.5 rounded-full bg-gold" />For students and early-career job seekers
          </p>
          <h1 className="serif text-4xl sm:text-[54px] leading-[1.06] tracking-tight">Land the job. <span className="text-brand">Not the ATS bin.</span></h1>
          <p className="text-lg text-ink-2 max-w-xl">
            See how well you match any job, fix your resume for the company&apos;s ATS, and get a cover letter and outreach
            messages in one click — all built only from your real resume.
          </p>
          <div className="flex flex-wrap gap-3">
            <ButtonLink href="/register" variant="primary" className="h-11 px-5">Create a free account</ButtonLink>
            <ButtonLink href="/login" className="h-11 px-5">Sign in</ButtonLink>
          </div>
          <p className="text-sm text-muted inline-flex items-center gap-1.5"><ShieldCheck aria-hidden className="size-4" />{DATA_PROMISE}</p>
        </div>
        <div className="relative">
          <div aria-hidden className="absolute -inset-6 rounded-[2rem] bg-gradient-to-br from-[#e3be6a]/25 via-transparent to-[#1b2f52]/20 blur-2xl" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/landing/match.webp" alt="Prepzy showing a 100% match for a Back End Developer Intern job" width={1600} height={900}
            className="relative w-full rounded-2xl border border-line shadow-[0_30px_80px_-30px_rgba(15,29,51,0.55)]" />
        </div>
      </section>

      <section aria-labelledby="features">
        <h2 id="features" className="serif text-3xl mb-2">Everything for your next application</h2>
        <p className="text-ink-2 mb-6">One place for the whole journey — from finding the job to the interview.</p>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <li key={f.title} className="rounded-2xl border border-line bg-surface surface-premium lift p-5 flex flex-col gap-3">
              <span aria-hidden className="icon-chip size-10"><f.icon className="size-5" /></span>
              <h3 className="font-semibold text-ink">{f.title}</h3>
              <p className="text-sm text-ink-2">{f.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Product tour" className="flex flex-col gap-16">
        {SHOWCASE.map((s, i) => (
          <div key={s.title} className="grid gap-8 lg:grid-cols-2 lg:items-center">
            <div className={i % 2 ? "lg:order-2" : ""}>
              <h2 className="serif text-3xl">{s.title}</h2>
              <p className="text-ink-2 mt-3 text-[17px] max-w-md">{s.body}</p>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.img} alt={s.title} width={1600} height={900} loading="lazy"
              className="w-full rounded-2xl border border-line shadow-[0_24px_60px_-30px_rgba(15,29,51,0.5)]" />
          </div>
        ))}
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
          <p className="text-white/85 mt-1">Two minutes: upload your resume, paste a job link, see your match.</p>
        </div>
        <ButtonLink href="/register" variant="ghost" className="h-11 px-6 btn-gold !text-[#1a1408] !border-transparent font-semibold">Get started free</ButtonLink>
      </section>
    </div>
  );
}
