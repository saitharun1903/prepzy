/** Job-tailored resume: data shape (from the API), the template catalogue, and LaTeX / text export. */

export type TemplateId = "classic" | "modern" | "ats";

export type TailoredEntry = {
  title: string; org: string | null; link: string | null; tech: string | null; location: string | null; dates: string | null; bullets: string[];
};
export type TailoredResume = {
  name: string;
  headline: string | null;
  contact: { phone: string | null; email: string | null; linkedin: string | null; github: string | null; website: string | null; location: string | null };
  summary: string | null;
  education: { school: string; degree: string | null; location: string | null; dates: string | null; score: string | null }[];
  skills: { group: string; items: string[] }[];
  experience: TailoredEntry[];
  projects: TailoredEntry[];
  achievements: string[];
};
export type TailorResult = {
  version_id: string; job_id: string; template: TemplateId; job_title: string; company: string | null;
  resume: TailoredResume; dropped: string[]; model: string; note: string;
};

export const TEMPLATES: { id: TemplateId; name: string; tagline: string }[] = [
  { id: "classic", name: "Classic", tagline: "The classic Overleaf look" },
  { id: "modern", name: "Modern", tagline: "Clean and modern" },
  { id: "ats", name: "ATS Simple", tagline: "Plain — safest for job portals" },
];

/** "**Java** and SQL" -> segments for rendering bold runs. */
export function boldSegments(text: string): { text: string; bold: boolean }[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((t) =>
    t.startsWith("**") && t.endsWith("**") ? { text: t.slice(2, -2), bold: true } : { text: t, bold: false });
}

const stripBold = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, "$1");

export function linkHref(v: string, kind: "email" | "phone" | "url"): string {
  if (kind === "email") return `mailto:${v}`;
  if (kind === "phone") return `tel:${v.replace(/[^\d+]/g, "")}`;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}
export const displayUrl = (v: string) => v.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");

// ------------------------------------------------------------------ LaTeX
const TEX_ESC: Record<string, string> = {
  "\\": "\\textbackslash{}", "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#", "_": "\\_", "{": "\\{", "}": "\\}",
  "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
};
export function tex(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/[\u2010\u2011\u2012\u2212]/g, "-").replace(/[\u00a0\u2009\u202f]/g, " ").replace(/[\u200b\ufeff]/g, "")
    .replace(/\u2026/g, "...").replace(/[\u2022\u25cf]/g, "-")
    .replace(/[\\&%$#_{}~^]/g, (c) => TEX_ESC[c]!).replace(/[–—]/g, "--").replace(/[“”]/g, "''").replace(/[‘’]/g, "'");
}
/** Escape, then turn **bold** into \textbf{}. */
function texRich(s: string): string {
  return boldSegments(s).map((p) => (p.bold ? `\\textbf{${tex(p.text)}}` : tex(p.text))).join("");
}
const texUrl = (v: string) => linkHref(v, "url").replace(/[%#]/g, (c) => `\\${c}`);

function texContact(r: TailoredResume, sep: string): string {
  const c = r.contact, parts: string[] = [];
  if (c.phone) parts.push(`\\faPhone\\ ${tex(c.phone)}`);
  if (c.email) parts.push(`\\faEnvelope\\ \\href{mailto:${tex(c.email)}}{${tex(c.email)}}`);
  if (c.linkedin) parts.push(`\\faLinkedin\\ \\href{${texUrl(c.linkedin)}}{${tex(displayUrl(c.linkedin))}}`);
  if (c.github) parts.push(`\\faGithub\\ \\href{${texUrl(c.github)}}{${tex(displayUrl(c.github))}}`);
  if (c.website) parts.push(`\\faGlobe\\ \\href{${texUrl(c.website)}}{${tex(displayUrl(c.website))}}`);
  if (c.location) parts.push(`\\faMapMarker*\\ ${tex(c.location)}`);
  return parts.join(sep);
}

function texEntries(items: TailoredEntry[]): string {
  return items.map((e) => {
    const left = `\\textbf{${tex(e.title)}}${e.org ? ` -- ${tex(e.org)}` : ""}${e.link ? ` \\,|\\, \\href{${texUrl(e.link)}}{\\underline{${tex(displayUrl(e.link))}}}` : ""}`;
    const right = e.dates ? `\\textit{${tex(e.dates)}}` : e.tech ? `\\textit{\\small ${tex(e.tech)}}` : "";
    const tight = e.bullets.length ? "[-9pt]" : "";
    const sub = e.dates && e.tech ? `\n  \\textit{\\small ${tex(e.tech)}}\\\\${tight}` : "";
    const bullets = e.bullets.length ? `\n  \\begin{itemize}\n${e.bullets.map((b) => `    \\item ${texRich(b)}`).join("\n")}\n  \\end{itemize}` : "";
    return `  ${left} \\hfill ${right}\\\\${sub ? "" : tight}${sub}${bullets}\n  \\vspace{3pt}`;
  }).join("\n\n");
}

export function toLatex(r: TailoredResume, t: TemplateId): string {
  const classic = t === "classic";
  const accent = classic ? "\\definecolor{accent}{rgb}{0.36,0.54,0.66} % airforceblue"
    : t === "modern" ? "\\definecolor{accent}{RGB}{27,47,82}\\definecolor{gold}{RGB}{201,162,75}" : "\\definecolor{accent}{RGB}{0,0,0}";
  const font = classic ? "\\usepackage{lmodern}" : t === "modern" ? "\\usepackage[default]{lato}" : "\\usepackage{mathptmx}";
  const heading = classic
    ? "\\titleformat{\\section}{\\fontfamily{ppl}\\selectfont\\large\\color{accent}}{}{0em}{\\MakeUppercase}[\\color{black}\\titlerule]"
    : t === "modern"
      ? "\\titleformat{\\section}{\\color{accent}\\bfseries\\normalsize}{}{0em}{\\MakeUppercase}[{\\color{gold}\\titlerule[1.2pt]}]"
      : "\\titleformat{\\section}{\\bfseries\\normalsize}{}{0em}{\\MakeUppercase}[\\titlerule]";
  const nameLine = classic
    ? `{\\fontfamily{ppl}\\selectfont\\Huge\\bfseries\\color{accent}\\MakeUppercase{${tex(r.name)}}}\\\\[6pt]`
    : t === "modern"
      ? `{\\color{accent}\\fontsize{26}{30}\\selectfont\\bfseries ${tex(r.name)}}\\\\[2pt]${r.headline ? `\n{\\large\\color{gold} ${tex(r.headline)}}\\\\[4pt]` : ""}`
      : `{\\Huge\\bfseries ${tex(r.name)}}\\\\[6pt]`;
  // Classic indents everything under a section title, like the usual Overleaf resume.
  const open = classic ? ["\\begin{resumebody}"] : [];
  const close = classic ? ["\\end{resumebody}"] : [];
  const out: string[] = [
    "% Generated by Prepzy -- compile with pdfLaTeX (e.g. on Overleaf).",
    "\\documentclass[10pt,a4paper]{article}",
    `\\usepackage[top=0.45in,bottom=0.45in,left=0.55in,right=0.55in]{geometry}`,
    font,
    "\\usepackage[T1]{fontenc}",
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage{xcolor}",
    "\\usepackage{titlesec}",
    "\\usepackage{enumitem}",
    "\\usepackage{fontawesome5}",
    "\\usepackage[hidelinks]{hyperref}",
    accent,
    "\\pagestyle{empty}",
    "\\setlength{\\parindent}{0pt}",
    heading,
    "\\titlespacing*{\\section}{0pt}{7pt}{4pt}",
    "\\setlist[itemize]{leftmargin=1.35em,itemsep=1pt,topsep=2pt,parsep=0pt,label=\\textbullet}",
    "\\newenvironment{resumebody}{\\begin{list}{}{\\setlength{\\leftmargin}{0.8em}\\setlength{\\topsep}{0pt}\\setlength{\\itemsep}{0pt}\\setlength{\\parsep}{0pt}}\\item[]}{\\end{list}}",
    "",
    "\\begin{document}",
    t === "modern" ? "" : "\\begin{center}",
    nameLine,
    `{\\small ${texContact(r, " \\quad ")}}`,
    t === "modern" ? "\\vspace{2pt}" : "\\end{center}",
  ];
  const section = (title: string, body: string[]) => out.push("", `\\section{${title}}`, ...open, ...body, ...close);
  if (r.summary) section("Professional Summary", [texRich(r.summary)]);
  if (r.education.length) {
    section("Education", r.education.flatMap((e, i) => [
      `\\textbf{${tex(e.school)}} \\hfill \\textbf{${tex(e.location ?? "")}}\\\\`,
      `\\textit{${tex(e.degree ?? "")}}${e.score ? ` \\,---\\, \\textit{${tex(e.score)}}` : ""} \\hfill \\textit{${tex(e.dates ?? "")}}${i < r.education.length - 1 ? "\\\\[2pt]" : ""}`,
    ]));
  }
  if (r.skills.length) {
    section("Technical Skills", r.skills.map((g, i) => `\\textbf{${tex(g.group)}:} ${g.items.map(tex).join(", ")}${i < r.skills.length - 1 ? "\\\\" : ""}`));
  }
  if (r.experience.length) section("Experience", [texEntries(r.experience)]);
  if (r.projects.length) section("Projects", [texEntries(r.projects)]);
  if (r.achievements.length) {
    section("Achievements \\& Certifications", ["\\begin{itemize}", ...r.achievements.map((a) => `  \\item ${texRich(a)}`), "\\end{itemize}"]);
  }
  out.push("", "\\end{document}", "");
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

// ------------------------------------------------------------------ plain text (paste into forms)
export function toPlainText(r: TailoredResume): string {
  const c = r.contact;
  const lines: string[] = [r.name.toUpperCase()];
  if (r.headline) lines.push(r.headline);
  lines.push([c.phone, c.email, c.linkedin, c.github, c.website, c.location].filter(Boolean).join(" | "));
  const sec = (t: string) => lines.push("", t.toUpperCase());
  if (r.summary) { sec("Professional summary"); lines.push(stripBold(r.summary)); }
  if (r.education.length) {
    sec("Education");
    for (const e of r.education) lines.push([e.school, e.location].filter(Boolean).join(", "), [e.degree, e.score, e.dates].filter(Boolean).join(" | "));
  }
  if (r.skills.length) { sec("Technical skills"); for (const g of r.skills) lines.push(`${g.group}: ${g.items.join(", ")}`); }
  for (const [title, items] of [["Experience", r.experience], ["Projects", r.projects]] as const) {
    if (!items.length) continue;
    sec(title);
    for (const e of items) {
      lines.push([e.title, e.org, e.link, e.dates].filter(Boolean).join(" | ") + (e.tech ? ` (${e.tech})` : ""));
      for (const b of e.bullets) lines.push(`- ${stripBold(b)}`);
    }
  }
  if (r.achievements.length) { sec("Achievements & certifications"); for (const a of r.achievements) lines.push(`- ${stripBold(a)}`); }
  return lines.join("\n");
}
