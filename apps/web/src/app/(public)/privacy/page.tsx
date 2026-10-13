import type { Metadata } from "next";
import { HOSTED, AI_PROVIDER } from "@/lib/hosting";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-2xl">
      <p className="text-[13px] text-muted mb-2">Data notice</p>
      <h1 className="serif text-4xl leading-tight mb-6">How Elevate handles your data</h1>
      <div className="flex flex-col gap-6 text-[15px] text-ink-2 leading-relaxed">
        <section>
          <h2 className="text-ink font-semibold mb-1">Where it is stored</h2>
          {HOSTED ? (
            <p>Your account, jobs, resumes, notes, plans and practice answers are stored in a private PostgreSQL database
              (Neon) used only by this Elevate service, which runs on Render. Uploaded resume files are stored in the same
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
              appear inside Elevate; calendar files can be downloaded manually.</li>
          </ul>
        </section>
        <section>
          <h2 className="text-ink font-semibold mb-1">Your control</h2>
          <p>You can export everything your account owns as a JSON file, and delete your account at any time from Settings.
            Deletion removes your records and schedules removal of stored files.</p>
        </section>
        <section>
          <h2 className="text-ink font-semibold mb-1">Browser extension</h2>
          <p>If you connect the extension, it reads only the tab you click it on, only when you click it, and sends that
            page&apos;s text to {HOSTED ? "your Elevate account" : "this local Elevate installation"}.</p>
        </section>
      </div>
    </article>
  );
}
