import type { Metadata } from "next";
import { HOSTED, AI_PROVIDER } from "@/lib/hosting";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-2xl">
      <p className="text-[13px] text-muted mb-2">Data notice</p>
      <h1 className="serif text-4xl leading-tight mb-6">How Prepzy handles your data</h1>
      <div className="flex flex-col gap-6 text-[15px] text-ink-2 leading-relaxed">
        <section>
          <h2 className="text-ink font-semibold mb-1">Where it is stored</h2>
          {HOSTED ? (
            <p>Your account, jobs, resumes, notes, plans and practice answers are stored in a private PostgreSQL database
              (Neon) used only by this Prepzy service, which runs on Render. Uploaded resume files are stored in the same
              database and can only be read through your signed-in account.</p>
          ) : (
            <p>Your account, jobs, resumes, notes, plans and practice answers are stored in a PostgreSQL database running
              locally with this installation. Uploaded resume files are kept as private files on the same machine.</p>
          )}
        </section>
        <section>
          <h2 className="text-ink font-semibold mb-1">How AI is used</h2>
          {HOSTED ? (
            <p>Job analysis, resume suggestions, interview questions and feedback are produced by an AI model run by{" "}
              {AI_PROVIDER}. The job text, resume text or answer being analysed is sent to {AI_PROVIDER} for that request;
              {" "}{AI_PROVIDER} states that it does not use this data to train models. Model output is checked against your
              source text, and anything that cannot be traced back to it is discarded or labelled.</p>
          ) : (
            <p>Job analysis, resume suggestions, interview questions and feedback are produced by a local Ollama model on this
              machine. Nothing is sent to external AI services. Model output is checked against your source text, and anything
              that cannot be traced back to it is discarded or labelled.</p>
          )}
        </section>
        <section>
          <h2 className="text-ink font-semibold mb-1">Limits</h2>
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>English-language job postings and resumes only.</li>
            <li>No OCR: scanned or image-only PDFs cannot be read. Use a text-based PDF, a DOCX file, or paste the text.</li>
            <li>Email is used only to confirm your address and reset your password. No push or calendar sync: reminders
              appear inside Prepzy; calendar files can be downloaded manually.</li>
          </ul>
        </section>
        <section>
          <h2 className="text-ink font-semibold mb-1">Your control</h2>
          <p>You can export everything your account owns as a JSON file, and delete your account at any time from Settings.
            Deletion removes your records and schedules removal of stored files.</p>
        </section>
        <section>
          <h2 className="text-ink font-semibold mb-1">Sign in with Google</h2>
          <p className="mb-4">If you choose &ldquo;Continue with Google&rdquo;, Google shares only your name, email address and a
            Google account ID with Prepzy. Prepzy doesn&apos;t receive your Google password and doesn&apos;t keep any Google
            access to your account, mail, contacts or files.</p>
          <h2 className="text-ink font-semibold mb-1">Browser extension</h2>
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>It acts only when you click the Prepzy icon, and only on that tab. It never reads your browsing history,
              other tabs, or pages you haven&apos;t clicked it on.</li>
            <li>What it reads: the visible text, title and address of that job page. It sends them to {HOSTED ? "your Prepzy account" : "this local Prepzy installation"} to analyse the job. Nothing else is collected.</li>
            <li>What it stores in your browser: your Prepzy sign-in token and the progress of the job you&apos;re analysing.
              Signing out, or &ldquo;Sign out everywhere&rdquo; in Settings, removes access.</li>
            <li>No ads, no tracking, no analytics, and your data is never sold or shared with third parties.</li>
          </ul>
        </section>
      </div>
    </article>
  );
}
