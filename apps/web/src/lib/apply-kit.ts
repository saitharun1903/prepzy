/** Apply kit: types, the cover-letter LaTeX document and small file helpers. */
import { tex, toLatex, type TailoredResume } from "@/lib/resume-templates";

export type CoverLetter = { greeting: string; paragraphs: string[]; closing: string };
export type Kit = {
  cover_letter: CoverLetter;
  linkedin_note: string;
  referral_message: string;
  cold_email: { subject: string; body: string };
  highlights: string[];
};
export type KitResult = {
  job_id: string; version_id: string; job_title: string; company: string | null; kit: Kit; removed: string[]; note: string;
};
export type CompileOut = { ok: boolean; ms: number; page_count: number; overfull?: boolean; errors: { line: number | null; message: string }[]; pdf: string | null; pages: string[] };

export const LINKEDIN_LIMIT = 300;

export function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFile = (s: string) => s.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "file";

/** The cover letter as plain text (for copy / email). */
export function letterText(l: CoverLetter, name: string | null): string {
  return [l.greeting, ...l.paragraphs, `${l.closing}\n${name ?? ""}`.trim()].filter(Boolean).join("\n\n");
}

/** A clean one-page business letter. Every user string is escaped; no user-controlled commands reach LaTeX. */
export function letterLatex(l: CoverLetter, r: TailoredResume | null, opts: { company: string | null; date: string }): string {
  const c = r?.contact;
  const contact = [c?.email, c?.phone, c?.linkedin?.replace(/^https?:\/\/(www\.)?/i, ""), c?.location].filter(Boolean).map((x) => tex(x)).join(" \\quad$\\cdot$\\quad ");
  const paras = l.paragraphs.map((p) => tex(p.trim())).filter(Boolean).join("\n\n");
  return `\\documentclass[11pt,a4paper]{article}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{lmodern}
\\usepackage{charter}
\\usepackage[top=2.2cm,bottom=2.2cm,left=2.5cm,right=2.5cm]{geometry}
\\usepackage{xcolor}
\\pagestyle{empty}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{0.85em}
\\begin{document}
${r?.name ? `{\\LARGE\\bfseries ${tex(r.name)}}\\par\\vspace{-0.5em}` : ""}
${contact ? `{\\small\\color{black!70} ${contact}}\\par` : ""}
\\vspace{0.6em}\\hrule\\vspace{1.2em}
${tex(opts.date)}\\par
${opts.company ? `${tex(opts.company)}\\par` : ""}
\\vspace{0.4em}
${tex(l.greeting)}

${paras}

${tex(l.closing)}\\par
${r?.name ? tex(r.name) : ""}
\\end{document}
`;
}

/** Build the resume PDF so it fills one page like a hand-made resume: 11pt if it fits on one page (else 10pt), then
 * the same size with stretched spacing so there's no empty band at the bottom. Two pages stay two pages. */
export async function fitToPage(
  r: TailoredResume, template: string, compile: (source: string) => Promise<CompileOut>,
): Promise<{ source: string; out: CompileOut }> {
  // Compile the page-filling version straight away; the compiler's own overflow warning says when it doesn't fit.
  // Usually one compile: 11pt filled. Long resumes drop to 10pt, and only past that to a plain (2-page) layout.
  for (const size of ["11pt", "10pt"] as const) {
    const src = toLatex(r, template, { size, fill: true });
    const out = await compile(src);
    if (out.ok && out.page_count === 1 && !out.overfull) return { source: src, out };
    if (!out.ok && size === "11pt") break;
  }
  const src = toLatex(r, template, { size: "10pt" });
  return { source: src, out: await compile(src) };
}
