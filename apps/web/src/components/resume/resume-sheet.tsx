"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { boldSegments, displayUrl, linkHref, type TailoredEntry, type TailoredResume, type TemplateId } from "@/lib/resume-templates";

/** A4 at 96 dpi. The sheet is laid out at real size (1pt = 4/3 px) and scaled to fit; printing uses real size. */
export const A4_W = 794;
export const A4_H = 1123;
const pt = (n: number) => `${(n * 4) / 3}px`;

// The same faces LaTeX uses: Computer Modern (Latin Modern) text, Palatino (TeX Gyre Pagella) for \fontfamily{ppl}.
const LM = "'LM Roman 10', 'Latin Modern Roman', 'CMU Serif', Georgia, serif";
const PPL = "'TeX Gyre Pagella', 'Palatino Linotype', Palatino, 'Book Antiqua', serif";
const TIMES = "'Times New Roman', Times, 'Liberation Serif', serif";
const SANS = "var(--font-geist-sans), 'Helvetica Neue', Helvetica, Arial, sans-serif";
const AIRFORCE = "#5d8aa8"; // xcolor "airforceblue"

type Theme = {
  font: string; size: number; leading: number; color: string; pad: string;
  nameFont: string; nameSize: number; nameColor: string; nameTransform?: CSSProperties["textTransform"]; nameWeight: number; nameTracking?: string;
  align: "center" | "left"; contactSize: number; icons: boolean;
  headFont: string; headSize: number; headColor: string; headWeight: number; headTransform?: CSSProperties["textTransform"]; headTracking?: string;
  rule: string; indent: number; accent: string; headline?: CSSProperties;
};

const THEMES: Record<TemplateId, Theme> = {
  // Mirrors the common Overleaf resume: \documentclass[10pt]{article}, \fontfamily{ppl}\Huge\bfseries\color{airforceblue}
  // name, uppercase Palatino section titles over a black \titlerule, content indented under each title.
  classic: {
    font: LM, size: 10, leading: 1.22, color: "#000", pad: `${pt(34)} ${pt(40)}`,
    nameFont: PPL, nameSize: 24.88, nameColor: AIRFORCE, nameTransform: "uppercase", nameWeight: 700, nameTracking: "0.01em",
    align: "center", contactSize: 9, icons: true,
    headFont: PPL, headSize: 12, headColor: AIRFORCE, headWeight: 400, headTransform: "uppercase", headTracking: "0.01em",
    rule: "0.6px solid #000", indent: 10, accent: "#000",
  },
  modern: {
    font: SANS, size: 9.6, leading: 1.38, color: "#1d2433", pad: `${pt(34)} ${pt(38)}`,
    nameFont: SANS, nameSize: 24, nameColor: "#1b2f52", nameWeight: 800, nameTracking: "-0.02em",
    align: "left", contactSize: 8.8, icons: true,
    headFont: SANS, headSize: 9, headColor: "#1b2f52", headWeight: 800, headTransform: "uppercase", headTracking: "0.14em",
    rule: "1.5px solid #c9a24b", indent: 0, accent: "#1b2f52", headline: { fontSize: pt(11), color: "#a17a24", fontWeight: 600 },
  },
  ats: {
    font: TIMES, size: 10.5, leading: 1.25, color: "#000", pad: `${pt(36)} ${pt(42)}`,
    nameFont: TIMES, nameSize: 20, nameColor: "#000", nameWeight: 700,
    align: "center", contactSize: 10, icons: false,
    headFont: TIMES, headSize: 11, headColor: "#000", headWeight: 700, headTransform: "uppercase", headTracking: "0.04em",
    rule: "0.8px solid #000", indent: 0, accent: "#000",
  },
};

// Minimal solid icons in the style of LaTeX's fontawesome5 (\faPhone, \faEnvelope, \faLinkedin, \faGithub, \faGlobe, \faMapMarker*).
const ICON: Record<string, string> = {
  phone: "M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z",
  mail: "M2 5.5A1.5 1.5 0 0 1 3.5 4h17A1.5 1.5 0 0 1 22 5.5v.4l-10 6.25L2 5.9zM2 8.25l9.47 5.92a1 1 0 0 0 1.06 0L22 8.25V18.5a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18.5z",
  linkedin: "M3 3h18v18H3zm4.2 7.4H5.1V19h2.1zm-1-3.6a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zM19 14.2c0-2.3-.5-4-3.1-4a2.7 2.7 0 0 0-2.5 1.4v-1.2h-2V19h2.1v-4.2c0-1.1.2-2.2 1.6-2.2s1.4 1.3 1.4 2.3V19H19z",
  github: "M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.4-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7 3.6 3.6 0 0 1 .1-2.6s.8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.6a3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z",
  globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-2.9a15.7 15.7 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8.2 8.2 0 0 1 0-4h3.4a16.5 16.5 0 0 0 0 4zm.8 2h2.9c.3 1.3.8 2.5 1.4 3.6A8 8 0 0 1 5.1 16zM8 8H5.1a8 8 0 0 1 4.3-3.6C8.8 5.5 8.3 6.7 8 8zm4 12c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4zm.3 5.6c.6-1.1 1.1-2.3 1.4-3.6h2.9a8 8 0 0 1-4.3 3.6zm1.7-5.6a16.5 16.5 0 0 0 0-4h3.4a8.2 8.2 0 0 1 0 4z",
  pin: "M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z",
};
function Icon({ name }: { name: keyof typeof ICON }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden style={{ display: "inline-block", width: "0.95em", height: "0.95em", verticalAlign: "-0.12em", marginRight: "0.32em", fill: "currentColor" }}>
      <path d={ICON[name]} />
    </svg>
  );
}

function Rich({ text }: { text: string }) {
  return <>{boldSegments(text).map((p, i) => (p.bold ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>))}</>;
}

function Section({ title, t, children }: { title: string; t: Theme; children: ReactNode }) {
  return (
    <section style={{ marginTop: pt(7) }}>
      <h2 style={{
        margin: 0, fontFamily: t.headFont, fontSize: pt(t.headSize), color: t.headColor, fontWeight: t.headWeight,
        textTransform: t.headTransform, letterSpacing: t.headTracking, lineHeight: 1.15,
      }}>{title}</h2>
      <div style={{ borderBottom: t.rule, margin: `${pt(1.5)} 0 ${pt(3.5)}` }} />
      <div style={{ paddingLeft: t.indent }}>{children}</div>
    </section>
  );
}

function TwoCol({ left, right, bold, italic }: { left: ReactNode; right: ReactNode; bold?: boolean; italic?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", fontWeight: bold ? 700 : undefined, fontStyle: italic ? "italic" : undefined }}>
      <span style={{ minWidth: 0 }}>{left}</span>
      {right ? <span style={{ whiteSpace: "nowrap", textAlign: "right" }}>{right}</span> : null}
    </div>
  );
}

function Entries({ items, t }: { items: TailoredEntry[]; t: Theme }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: pt(5) }}>
      {items.map((e, i) => (
        <div key={i}>
          <TwoCol
            left={<>
              <b>{e.title}</b>
              {e.org ? <> <span>— {e.org}</span></> : null}
              {e.link ? <> <span style={{ margin: "0 0.35em" }}>—</span><a href={linkHref(e.link, "url")} style={{ color: t.accent, textDecoration: "underline", textUnderlineOffset: "1.5px" }}>{displayUrl(e.link)}</a></> : null}
            </>}
            right={<i>{e.dates || e.tech}</i>}
          />
          {e.dates && e.tech ? <div style={{ fontStyle: "italic", fontSize: "0.92em" }}>{e.tech}</div> : null}
          {e.bullets.length ? (
            <ul style={{ margin: `${pt(2.5)} 0 0`, paddingLeft: "1.35em", listStyle: "none" }}>
              {e.bullets.map((b, j) => (
                <li key={j} style={{ position: "relative", marginTop: pt(1), textAlign: "justify", hyphens: "auto" }}>
                  <span aria-hidden style={{ position: "absolute", left: "-0.95em" }}>•</span><Rich text={b} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function ResumeSheet({ resume: r, template, id }: { resume: TailoredResume; template: TemplateId; id?: string }) {
  const t = THEMES[template];
  const c = r.contact;
  const items: { icon: keyof typeof ICON; node: ReactNode }[] = [];
  if (c.phone) items.push({ icon: "phone", node: <a href={linkHref(c.phone, "phone")}>{c.phone}</a> });
  if (c.email) items.push({ icon: "mail", node: <a href={linkHref(c.email, "email")}>{c.email}</a> });
  if (c.linkedin) items.push({ icon: "linkedin", node: <a href={linkHref(c.linkedin, "url")}>{displayUrl(c.linkedin)}</a> });
  if (c.github) items.push({ icon: "github", node: <a href={linkHref(c.github, "url")}>{displayUrl(c.github)}</a> });
  if (c.website) items.push({ icon: "globe", node: <a href={linkHref(c.website, "url")}>{displayUrl(c.website)}</a> });
  if (c.location) items.push({ icon: "pin", node: <span>{c.location}</span> });

  return (
    <article id={id} className="resume-sheet" style={{
      width: A4_W, minHeight: A4_H, boxSizing: "border-box", background: "#fff", padding: t.pad,
      fontFamily: t.font, fontSize: pt(t.size), lineHeight: t.leading, color: t.color,
      fontKerning: "normal", textRendering: "geometricPrecision", WebkitFontSmoothing: "antialiased",
    }}>
      <header style={{ textAlign: t.align }}>
        <h1 style={{
          margin: 0, fontFamily: t.nameFont, fontSize: pt(t.nameSize), fontWeight: t.nameWeight, color: t.nameColor,
          textTransform: t.nameTransform, letterSpacing: t.nameTracking, lineHeight: 1.1,
        }}>{r.name}</h1>
        {r.headline && t.headline ? <p style={{ margin: `${pt(3)} 0 0`, ...t.headline }}>{r.headline}</p> : null}
        <p style={{
          margin: `${pt(5)} 0 0`, fontSize: pt(t.contactSize), display: "flex", flexWrap: "wrap", columnGap: "1.1em", rowGap: 2,
          justifyContent: t.align === "center" ? "center" : "flex-start",
        }}>
          {items.map((x, i) => (
            <span key={i} style={{ whiteSpace: "nowrap" }}>
              {t.icons ? <Icon name={x.icon} /> : i ? <span aria-hidden style={{ marginRight: "1.1em", marginLeft: "-0.55em" }}>|</span> : null}{x.node}
            </span>
          ))}
        </p>
        {template === "modern" ? <div style={{ height: 3, width: 64, background: "#c9a24b", borderRadius: 2, marginTop: pt(7) }} /> : null}
      </header>

      {r.summary ? <Section title="Professional Summary" t={t}><p style={{ margin: 0, textAlign: "justify", hyphens: "auto" }}><Rich text={r.summary} /></p></Section> : null}

      {r.education.length ? (
        <Section title="Education" t={t}>
          <div style={{ display: "flex", flexDirection: "column", gap: pt(3) }}>
            {r.education.map((e, i) => (
              <div key={i}>
                <TwoCol bold left={e.school} right={e.location} />
                <TwoCol italic left={[e.degree, e.score].filter(Boolean).join("  —  ")} right={e.dates} />
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {r.skills.length ? (
        <Section title="Technical Skills" t={t}>
          <div style={{ display: "flex", flexDirection: "column", gap: pt(1.5) }}>
            {r.skills.map((g, i) => <div key={i}><b>{g.group}:</b> {g.items.join(", ")}</div>)}
          </div>
        </Section>
      ) : null}

      {r.experience.length ? <Section title="Experience" t={t}><Entries items={r.experience} t={t} /></Section> : null}
      {r.projects.length ? <Section title="Projects" t={t}><Entries items={r.projects} t={t} /></Section> : null}

      {r.achievements.length ? (
        <Section title="Achievements & Certifications" t={t}>
          <ul style={{ margin: 0, paddingLeft: "1.35em", listStyle: "none" }}>
            {r.achievements.map((a, i) => (
              <li key={i} style={{ position: "relative", marginTop: pt(1) }}>
                <span aria-hidden style={{ position: "absolute", left: "-0.95em" }}>•</span><Rich text={a} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </article>
  );
}

/** Scales the real-size sheet to the available width (preview only). */
export function ScaledSheet({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(A4_H);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const s = Math.min(1, el.clientWidth / A4_W);
      setScale(s);
      setHeight((inner.current?.scrollHeight ?? A4_H) * s);
    });
    ro.observe(el);
    if (inner.current) ro.observe(inner.current);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} style={{ width: "100%", height }} className="overflow-hidden">
      <div ref={inner} style={{ width: A4_W, transform: `scale(${scale})`, transformOrigin: "top left" }}
        className="shadow-[0_20px_60px_-30px_rgba(15,29,51,0.5)] ring-1 ring-black/5">
        {children}
      </div>
    </div>
  );
}
