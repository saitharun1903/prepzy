"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { boldSegments, displayUrl, linkHref, type TailoredEntry, type TailoredResume, type TemplateId } from "@/lib/resume-templates";

/** A4 at 96 dpi. The sheet is laid out at real size and scaled to fit; printing uses real size. */
export const A4_W = 794;
export const A4_H = 1123;

type Theme = {
  page: CSSProperties; name: CSSProperties; headline: CSSProperties; contact: CSSProperties; align: "center" | "left";
  heading: CSSProperties; rule: string; body: CSSProperties; accent: string;
};

const PALATINO = "'Palatino Linotype', Palatino, 'Book Antiqua', 'URW Palladio L', 'TeX Gyre Pagella', serif";
const LMODERN = "'Latin Modern Roman', 'CMU Serif', 'Computer Modern Serif', 'Palatino Linotype', Palatino, Georgia, serif";
const TIMES = "'Times New Roman', Times, 'Liberation Serif', 'Nimbus Roman', serif";
const SANS = "var(--font-geist-sans), 'Helvetica Neue', Helvetica, Arial, sans-serif";

const THEMES: Record<TemplateId, Theme> = {
  classic: {
    page: { fontFamily: LMODERN, color: "#111", padding: "44px 54px" }, align: "center", accent: "#4f7ea0",
    name: { fontFamily: PALATINO, fontSize: 30, fontWeight: 700, letterSpacing: "0.02em", color: "#4f7ea0", fontVariant: "small-caps" },
    headline: { fontSize: 13, color: "#333", fontStyle: "italic" },
    contact: { fontSize: 10.5, color: "#222", gap: "6px 16px" },
    heading: { fontFamily: PALATINO, fontVariant: "small-caps", fontSize: 15, color: "#4f7ea0", letterSpacing: "0.02em" }, rule: "1px solid #222",
    body: { fontSize: 10.6, lineHeight: 1.38 },
  },
  modern: {
    page: { fontFamily: SANS, color: "#1d2433", padding: "44px 52px" }, align: "left", accent: "#1b2f52",
    name: { fontSize: 32, fontWeight: 800, letterSpacing: "-0.02em", color: "#1b2f52" },
    headline: { fontSize: 14, color: "#a17a24", fontWeight: 600 },
    contact: { fontSize: 10.5, color: "#3a4356", gap: "4px 14px" },
    heading: { fontSize: 11.5, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase", color: "#1b2f52" }, rule: "1.5px solid #c9a24b",
    body: { fontSize: 10.4, lineHeight: 1.42 },
  },
  ats: {
    page: { fontFamily: TIMES, color: "#000", padding: "44px 56px" }, align: "center", accent: "#000",
    name: { fontSize: 26, fontWeight: 700, color: "#000" },
    headline: { fontSize: 12.5, color: "#000" },
    contact: { fontSize: 11, color: "#000", gap: "4px 12px" },
    heading: { fontSize: 12.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "#000" }, rule: "1px solid #000",
    body: { fontSize: 11, lineHeight: 1.35 },
  },
};

function Rich({ text }: { text: string }) {
  return <>{boldSegments(text).map((p, i) => (p.bold ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>))}</>;
}

function Section({ title, theme, children }: { title: string; theme: Theme; children: ReactNode }) {
  return (
    <section style={{ marginTop: 12 }}>
      <h2 style={{ margin: 0, ...theme.heading }}>{title}</h2>
      <div style={{ borderBottom: theme.rule, margin: "2px 0 6px" }} />
      {children}
    </section>
  );
}

function Entries({ items, theme }: { items: TailoredEntry[]; theme: Theme }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {items.map((e, i) => (
        <div key={i}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
            <div>
              <b>{e.title}</b>
              {e.org ? <span> — {e.org}</span> : null}
              {e.link ? <> <span style={{ color: "#888" }}>|</span> <a href={linkHref(e.link, "url")} style={{ color: theme.accent, textDecoration: "underline" }}>{displayUrl(e.link)}</a></> : null}
            </div>
            <i style={{ whiteSpace: "nowrap", fontSize: "0.95em" }}>{e.dates || e.tech}</i>
          </div>
          {e.dates && e.tech ? <i style={{ fontSize: "0.92em", color: "#444" }}>{e.tech}</i> : null}
          {e.bullets.length ? (
            <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
              {e.bullets.map((b, j) => <li key={j} style={{ marginTop: 1 }}><Rich text={b} /></li>)}
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
  const contact: ReactNode[] = [];
  if (c.phone) contact.push(<a key="p" href={linkHref(c.phone, "phone")}>{c.phone}</a>);
  if (c.email) contact.push(<a key="e" href={linkHref(c.email, "email")}>{c.email}</a>);
  if (c.linkedin) contact.push(<a key="l" href={linkHref(c.linkedin, "url")}>{displayUrl(c.linkedin)}</a>);
  if (c.github) contact.push(<a key="g" href={linkHref(c.github, "url")}>{displayUrl(c.github)}</a>);
  if (c.website) contact.push(<a key="w" href={linkHref(c.website, "url")}>{displayUrl(c.website)}</a>);
  if (c.location) contact.push(<span key="loc">{c.location}</span>);

  return (
    <article id={id} className="resume-sheet" style={{ width: A4_W, minHeight: A4_H, boxSizing: "border-box", background: "#fff", ...t.page, ...t.body }}>
      <header style={{ textAlign: t.align }}>
        <h1 style={{ margin: 0, lineHeight: 1.1, ...t.name }}>{r.name}</h1>
        {r.headline && template !== "classic" ? <p style={{ margin: "4px 0 0", ...t.headline }}>{r.headline}</p> : null}
        <p style={{ margin: "8px 0 0", display: "flex", flexWrap: "wrap", justifyContent: t.align === "center" ? "center" : "flex-start", ...t.contact }}>
          {contact.map((x, i) => <span key={i} style={{ color: "inherit" }}>{x}</span>)}
        </p>
        {template === "modern" ? <div style={{ height: 3, width: 64, background: "#c9a24b", borderRadius: 2, marginTop: 10 }} /> : null}
      </header>

      {r.summary ? <Section title="Professional Summary" theme={t}><p style={{ margin: 0, textAlign: "justify" }}><Rich text={r.summary} /></p></Section> : null}

      {r.education.length ? (
        <Section title="Education" theme={t}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {r.education.map((e, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto", columnGap: 12 }}>
                <b>{e.school}</b><b style={{ textAlign: "right" }}>{e.location}</b>
                <i>{[e.degree, e.score].filter(Boolean).join(" — ")}</i><i style={{ textAlign: "right" }}>{e.dates}</i>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {r.skills.length ? (
        <Section title="Technical Skills" theme={t}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {r.skills.map((g, i) => <div key={i}><b>{g.group}:</b> {g.items.join(", ")}</div>)}
          </div>
        </Section>
      ) : null}

      {r.experience.length ? <Section title="Experience" theme={t}><Entries items={r.experience} theme={t} /></Section> : null}
      {r.projects.length ? <Section title="Projects" theme={t}><Entries items={r.projects} theme={t} /></Section> : null}

      {r.achievements.length ? (
        <Section title="Achievements & Certifications" theme={t}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{r.achievements.map((a, i) => <li key={i}><Rich text={a} /></li>)}</ul>
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
