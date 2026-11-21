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
  version_id: string; job_id: string | null; template: TemplateId; job_title: string | null; company: string | null;
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

function texEntries(items: TailoredEntry[], gap = "\\vspace{3pt}"): string {
  return items.map((e) => {
    const left = `\\textbf{${tex(e.title)}}${e.org ? ` -- ${tex(e.org)}` : ""}${e.link ? ` \\,|\\, \\href{${texUrl(e.link)}}{\\underline{${tex(displayUrl(e.link))}}}` : ""}`;
    const right = e.dates ? `\\textit{${tex(e.dates)}}` : e.tech ? `\\textit{\\small ${tex(e.tech)}}` : "";
    const tight = e.bullets.length ? "[-9pt]" : "";
    const sub = e.dates && e.tech ? `\n  \\textit{\\small ${tex(e.tech)}}\\\\${tight}` : "";
    const bullets = e.bullets.length ? `\n  \\begin{itemize}\n${e.bullets.map((b) => `    \\item ${texRich(b)}`).join("\n")}\n  \\end{itemize}` : "";
    return `  ${left} \\hfill ${right}\\\\${sub ? "" : tight}${sub}${bullets}\n  ${gap}`;
  }).join("\n\n");
}

// ------------------------------------------------------------------ LaTeX template engine
/** One professional resume design. Every font here ships with TeX Live's recommended fonts, lmodern or TeX Gyre,
 * and the production image compiles every template at build time, so all of them are guaranteed to work. */
export type LatexTemplate = {
  id: string; label: string; tagline: string; category: "Classic" | "Modern" | "Minimal" | "Executive";
  font: string[];                 // preamble lines selecting the body font
  nameFont?: string;              // e.g. \fontfamily{ppl}\selectfont
  accent: string;                 // hex, no '#'
  align: "center" | "left";
  name: { size: string; bold: boolean; caps: "upper" | "small" | "none"; color: boolean };
  headline: boolean;
  heading: { caps: "upper" | "small" | "none"; bold: boolean; size: string; color: boolean; font?: string; center?: boolean;
    rule: "thin" | "thick" | "accent" | "none" };
  contact: "icons" | "pipes" | "bullets";
  indent: boolean;
  bullet: string;
  topRule?: boolean;              // accent bar under the header
};

export const LATEX_TEMPLATE_LIST: LatexTemplate[] = [
  { id: "classic", label: "Classic", tagline: "The Overleaf favourite — Palatino name, blue headings", category: "Classic",
    font: ["\\usepackage{lmodern}"], nameFont: "\\fontfamily{ppl}\\selectfont", accent: "5D8AA8", align: "center",
    name: { size: "\\Huge", bold: true, caps: "upper", color: true }, headline: false,
    heading: { caps: "upper", bold: false, size: "\\large", color: true, font: "\\fontfamily{ppl}\\selectfont", rule: "thin" },
    contact: "icons", indent: true, bullet: "\\textbullet" },
  { id: "compact", label: "Compact", tagline: "Dense one-page student layout with small caps", category: "Classic",
    font: ["\\usepackage{lmodern}"], accent: "000000", align: "center",
    name: { size: "\\Huge", bold: false, caps: "small", color: false }, headline: false,
    heading: { caps: "small", bold: false, size: "\\large", color: false, rule: "thin" },
    contact: "pipes", indent: false, bullet: "\\textbullet" },
  { id: "modern", label: "Modern", tagline: "Clean sans-serif with navy and gold", category: "Modern",
    font: ["\\usepackage{tgheros}", "\\renewcommand{\\familydefault}{\\sfdefault}"], accent: "1B2F52", align: "left",
    name: { size: "\\Huge", bold: true, caps: "none", color: true }, headline: true,
    heading: { caps: "upper", bold: true, size: "\\normalsize", color: true, rule: "accent" },
    contact: "icons", indent: false, bullet: "\\textbullet" },
  { id: "ats", label: "ATS Simple", tagline: "Plain Times, no colour — safest for job portals", category: "Minimal",
    font: ["\\usepackage{mathptmx}"], accent: "000000", align: "center",
    name: { size: "\\Huge", bold: true, caps: "none", color: false }, headline: false,
    heading: { caps: "upper", bold: true, size: "\\normalsize", color: false, rule: "thin" },
    contact: "pipes", indent: false, bullet: "\\textbullet" },
  { id: "executive", label: "Executive", tagline: "Palatino with burgundy accents and a strong rule", category: "Executive",
    font: ["\\usepackage{tgpagella}"], accent: "7A1F2B", align: "center",
    name: { size: "\\Huge", bold: false, caps: "small", color: true }, headline: true,
    heading: { caps: "small", bold: true, size: "\\large", color: true, rule: "thick" },
    contact: "bullets", indent: true, bullet: "\\textbullet" },
  { id: "charter", label: "Charter", tagline: "Bitstream Charter, teal headings — calm and readable", category: "Classic",
    font: ["\\usepackage{charter}"], accent: "0F766E", align: "left",
    name: { size: "\\huge", bold: true, caps: "none", color: false }, headline: true,
    heading: { caps: "none", bold: true, size: "\\large", color: true, rule: "thin" },
    contact: "icons", indent: false, bullet: "\\textendash" },
  { id: "swiss", label: "Swiss", tagline: "Helvetica, black and grey — sharp and minimal", category: "Minimal",
    font: ["\\usepackage[scaled=0.95]{helvet}", "\\renewcommand{\\familydefault}{\\sfdefault}"], accent: "4B5563", align: "left",
    name: { size: "\\Huge", bold: true, caps: "none", color: false }, headline: true,
    heading: { caps: "upper", bold: true, size: "\\small", color: true, rule: "thin" },
    contact: "pipes", indent: false, bullet: "\\textbullet" },
  { id: "elegant", label: "Elegant", tagline: "Century Schoolbook with centred headings", category: "Executive",
    font: ["\\usepackage{tgschola}"], accent: "1F2937", align: "center",
    name: { size: "\\huge", bold: false, caps: "upper", color: false }, headline: true,
    heading: { caps: "small", bold: false, size: "\\large", color: false, center: true, rule: "thin" },
    contact: "bullets", indent: false, bullet: "\\textbullet" },
  { id: "tech", label: "Tech", tagline: "Geometric sans with bright blue — great for developers", category: "Modern",
    font: ["\\usepackage{tgadventor}", "\\renewcommand{\\familydefault}{\\sfdefault}"], accent: "2563EB", align: "left",
    name: { size: "\\huge", bold: true, caps: "none", color: true }, headline: true,
    heading: { caps: "upper", bold: true, size: "\\normalsize", color: true, rule: "none" },
    contact: "icons", indent: false, bullet: "$\\triangleright$", topRule: true },
  { id: "bookman", label: "Warm", tagline: "Bookman with warm brown accents — friendly and confident", category: "Classic",
    font: ["\\usepackage{tgbonum}"], accent: "8B5E34", align: "center",
    name: { size: "\\huge", bold: true, caps: "none", color: true }, headline: false,
    heading: { caps: "upper", bold: true, size: "\\normalsize", color: true, rule: "thin" },
    contact: "bullets", indent: true, bullet: "\\textbullet" },
  { id: "utopia", label: "Utopia", tagline: "Adobe Utopia, indigo small caps — refined", category: "Executive",
    font: ["\\usepackage{utopia}"], accent: "3730A3", align: "left",
    name: { size: "\\Huge", bold: true, caps: "none", color: true }, headline: true,
    heading: { caps: "small", bold: true, size: "\\large", color: true, rule: "thin" },
    contact: "icons", indent: false, bullet: "\\textbullet" },
  { id: "navy", label: "Navy", tagline: "Times with navy headings and rules — traditional", category: "Classic",
    font: ["\\usepackage{tgtermes}"], accent: "1E3A8A", align: "center",
    name: { size: "\\Huge", bold: true, caps: "none", color: true }, headline: false,
    heading: { caps: "upper", bold: true, size: "\\normalsize", color: true, rule: "accent" },
    contact: "pipes", indent: false, bullet: "\\textbullet" },
  { id: "graphite", label: "Graphite", tagline: "Helvetica in charcoal tones, centred", category: "Modern",
    font: ["\\usepackage[scaled=0.95]{helvet}", "\\renewcommand{\\familydefault}{\\sfdefault}"], accent: "374151", align: "center",
    name: { size: "\\huge", bold: true, caps: "upper", color: true }, headline: true,
    heading: { caps: "upper", bold: true, size: "\\small", color: true, rule: "accent" },
    contact: "bullets", indent: false, bullet: "\\textbullet", topRule: false },
  { id: "emerald", label: "Emerald", tagline: "Latin Modern Sans with green accents", category: "Modern",
    font: ["\\usepackage{lmodern}", "\\renewcommand{\\familydefault}{\\sfdefault}"], accent: "047857", align: "left",
    name: { size: "\\Huge", bold: true, caps: "none", color: true }, headline: true,
    heading: { caps: "none", bold: true, size: "\\large", color: true, rule: "thick" },
    contact: "icons", indent: false, bullet: "\\textbullet" },
  { id: "crimson", label: "Crimson", tagline: "Palatino with a crimson header bar", category: "Executive",
    font: ["\\usepackage{mathpazo}"], accent: "B91C1C", align: "left",
    name: { size: "\\Huge", bold: true, caps: "none", color: false }, headline: true,
    heading: { caps: "upper", bold: true, size: "\\normalsize", color: true, rule: "none" },
    contact: "icons", indent: true, bullet: "\\textbullet", topRule: true },
  { id: "minimal", label: "Minimal", tagline: "Lots of white space, no rules — quietly modern", category: "Minimal",
    font: ["\\usepackage{lmodern}"], accent: "111827", align: "left",
    name: { size: "\\huge", bold: true, caps: "none", color: false }, headline: true,
    heading: { caps: "small", bold: false, size: "\\Large", color: false, rule: "none" },
    contact: "pipes", indent: false, bullet: "\\textendash" },
];

export type LatexStyle = string;
const BY_ID = new Map(LATEX_TEMPLATE_LIST.map((t) => [t.id, t]));
export const latexTemplate = (id: string): LatexTemplate => BY_ID.get(id) ?? LATEX_TEMPLATE_LIST[0]!;

function texContactFor(r: TailoredResume, mode: LatexTemplate["contact"]): string {
  const c = r.contact;
  if (mode === "icons") return texContact(r, " \\quad ");
  const parts: string[] = [];
  if (c.phone) parts.push(tex(c.phone));
  if (c.email) parts.push(`\\href{mailto:${tex(c.email)}}{${tex(c.email)}}`);
  for (const v of [c.linkedin, c.github, c.website]) if (v) parts.push(`\\href{${texUrl(v)}}{${tex(displayUrl(v))}}`);
  if (c.location) parts.push(tex(c.location));
  return parts.join(mode === "pipes" ? " $|$ " : " \\textbullet{} ");
}

/** size: base font size. fill: stretch the spacing so a one-page resume fills the whole page (only use it when the
 * same content already fits on one page at this size - see fitToPage). */
export type LatexOptions = { size?: "10pt" | "11pt"; fill?: boolean };

export function toLatex(r: TailoredResume, id: LatexStyle, opts: LatexOptions = {}): string {
  const size = opts.size ?? "10pt";
  const fill = Boolean(opts.fill);
  const t = latexTemplate(id);
  const h = t.heading;
  const caps = (k: "upper" | "small" | "none") => (k === "small" ? "\\scshape" : "");
  const headFmt = [h.center ? "\\filcenter" : "", h.font ?? "", h.size, h.bold ? "\\bfseries" : "", caps(h.caps), h.color ? "\\color{accent}" : ""].join("");
  const after = h.rule === "thin" ? "[\\color{black}\\titlerule]" : h.rule === "thick" ? "[{\\color{accent}\\titlerule[1.2pt]}]"
    : h.rule === "accent" ? "[{\\color{accent}\\titlerule[0.8pt]}]" : "";
  const before = h.caps === "upper" ? "\\MakeUppercase" : "";
  const n = t.name;
  const nameBody = n.caps === "upper" ? `\\MakeUppercase{${tex(r.name)}}` : tex(r.name);
  const nameLine = `{${t.nameFont ?? ""}${n.size}${n.bold ? "\\bfseries" : ""}${n.caps === "small" ? "\\scshape" : ""}${n.color ? "\\color{accent}" : ""} ${nameBody}}\\\\[5pt]`;
  const headline = t.headline && r.headline ? `{\\large ${t.accent !== "000000" ? "\\color{accent}" : ""}${tex(r.headline)}}\\\\[4pt]` : "";
  const open = t.indent ? ["\\begin{resumebody}"] : [];
  const close = t.indent ? ["\\end{resumebody}"] : [];
  const out: string[] = [
    `% ${t.label} resume template -- generated by Prepzy. Compile with pdfLaTeX (also works on Overleaf).`,
    `\\documentclass[${size},a4paper]{article}`,
    "\\usepackage[top=0.45in,bottom=0.45in,left=0.55in,right=0.55in]{geometry}",
    ...t.font,
    "\\usepackage[T1]{fontenc}",
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage{xcolor}",
    "\\usepackage{titlesec}",
    "\\usepackage{enumitem}",
    "\\usepackage{fontawesome5}",
    "\\usepackage[hidelinks]{hyperref}",
    `\\definecolor{accent}{HTML}{${t.accent}}`,
    "\\pagestyle{empty}",
    "\\setlength{\\parindent}{0pt}",
    `\\titleformat{\\section}{${headFmt}}{}{0em}{${before}}${after}`,
    fill ? "\\titlespacing*{\\section}{0pt}{8pt plus 10pt}{4pt plus 3pt}" : "\\titlespacing*{\\section}{0pt}{8pt}{4pt}",
    `\\setlist[itemize]{leftmargin=1.35em,itemsep=${fill ? "1pt plus 2pt" : "1pt"},topsep=${fill ? "2pt plus 2pt" : "2pt"},parsep=0pt,label=${t.bullet}}`,
    "\\newenvironment{resumebody}{\\begin{list}{}{\\setlength{\\leftmargin}{0.8em}\\setlength{\\topsep}{0pt}\\setlength{\\itemsep}{0pt}\\setlength{\\parsep}{0pt}}\\item[]}{\\end{list}}",
    "",
    "\\begin{document}",
    // [b]: measure from the bottom, so a big name on the first line can't push the box past the page
    ...(fill ? ["\\noindent\\begin{minipage}[b][\\dimexpr\\textheight-2pt\\relax][s]{\\linewidth}"] : []),
    t.align === "center" ? "\\begin{center}" : "\\begin{flushleft}",
    nameLine,
    ...(headline ? [headline] : []),
    `{\\small ${texContactFor(r, t.contact)}}`,
    t.align === "center" ? "\\end{center}" : "\\end{flushleft}",
    ...(t.topRule ? ["\\vspace{-6pt}{\\color{accent}\\rule{\\linewidth}{2pt}}", "\\vspace{-2pt}"] : []),
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
  const gap = fill ? "\\vspace{3pt plus 6pt}" : "\\vspace{3pt}";
  if (r.experience.length) section("Experience", [texEntries(r.experience, gap)]);
  if (r.projects.length) section("Projects", [texEntries(r.projects, gap)]);
  if (r.achievements.length) {
    section("Achievements \\& Certifications", ["\\begin{itemize}", ...r.achievements.map((a) => `  \\item ${texRich(a)}`), "\\end{itemize}"]);
  }
  out.push("", ...(fill ? ["\\end{minipage}"] : []), "\\end{document}", "");
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

// ------------------------------------------------------------------ resume builder starters
export const LATEX_TEMPLATES = LATEX_TEMPLATE_LIST.map(({ id, label, tagline, category }) => ({ id, name: label, tagline, category }));

/** Placeholder content for a new resume: obviously fictional, so nobody ships it by mistake. */
export const SAMPLE_RESUME: TailoredResume = {
  name: "Your Name",
  headline: "Software Engineer",
  contact: { phone: "+91 90000 00000", email: "you@example.com", linkedin: "linkedin.com/in/your-profile", github: "github.com/your-handle", website: null, location: "City, Country" },
  summary: "Final-year **Computer Science** student who builds web applications with **Java**, **Spring Boot** and **React**. Replace this with two or three lines about what you do best and the role you want.",
  education: [
    { school: "Your University", degree: "B.Tech in Computer Science", location: "City", dates: "2023 -- 2027", score: "CGPA: 9.0" },
  ],
  skills: [
    { group: "Languages", items: ["Java", "Python", "JavaScript", "SQL"] },
    { group: "Frameworks", items: ["Spring Boot", "React", "Node.js"] },
    { group: "Tools", items: ["Git", "Docker", "Postman", "VS Code"] },
  ],
  experience: [
    { title: "Software Engineering Intern", org: "Company Name", link: null, tech: null, location: null, dates: "May 2026 -- Jul 2026",
      bullets: ["Built **REST APIs** with Spring Boot used by the internal dashboard.", "Wrote unit tests that raised coverage from **40% to 75%**."] },
  ],
  projects: [
    { title: "Project Name", org: null, link: "github.com/your-handle/project", tech: "React, Node.js, MongoDB", location: null, dates: null,
      bullets: ["Describe what it does and who uses it.", "Mention one result: users, speed-up, or what you learned."] },
  ],
  achievements: ["Solved **300+** problems on LeetCode.", "Certificate or award -- Issuer"],
};
