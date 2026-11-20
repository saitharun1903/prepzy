"use client";

import Link from "next/link";
import {
  forwardRef, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Info, Loader2, MailWarning, X, XCircle } from "lucide-react";
import { apiFetch, type ApiError } from "@/lib/api";

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- Button
type Variant = "primary" | "secondary" | "ghost" | "danger" | "link";
type Size = "sm" | "md";
const variants: Record<Variant, string> = {
  primary: "btn-gloss bg-accent text-accent-ink border border-white/10",
  secondary: "btn-sheen text-ink border border-line-strong hover:border-accent/40 hover:text-accent",
  ghost: "bg-transparent text-ink-2 border border-transparent hover:bg-surface-2 hover:text-ink",
  danger: "bg-danger text-white border border-transparent shadow-sm hover:brightness-110 bg-[image:var(--gloss)]",
  link: "bg-transparent text-accent underline underline-offset-4 border-0 px-0 hover:opacity-80",
};
const sizes: Record<Size, string> = { sm: "h-8 px-3 text-[13px] gap-1.5", md: "h-10 px-4 text-sm gap-2" };

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, className, children, disabled, type = "button", ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap transition-[background,opacity,color] duration-[var(--dur-fast)]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        variant !== "link" && sizes[size], variants[variant], className,
      )}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden className="size-4 spin" /> : null}
      {children}
    </button>
  );
});

export function ButtonLink({ href, variant = "secondary", size = "md", className, children, ...rest }: {
  href: string; variant?: Variant; size?: Size; className?: string; children: ReactNode; "aria-label"?: string;
}) {
  return (
    <Link
      href={href}
      className={cx("inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap", variant !== "link" && sizes[size], variants[variant], className)}
      {...rest}
    >
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------- Form fields
export function Field({ label, hint, error, children, id, required, className }: {
  label: ReactNode; hint?: ReactNode; error?: string | null; children: (props: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
  id?: string; required?: boolean; className?: string;
}) {
  const auto = useId();
  const fid = id || auto;
  const hintId = hint ? `${fid}-hint` : undefined;
  const errId = error ? `${fid}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={fid} className="text-sm font-medium text-ink">
        {label}
        {required ? <span className="text-muted font-normal"> (required)</span> : null}
      </label>
      {children({ id: fid, describedBy, invalid: Boolean(error) })}
      {hint ? <p id={hintId} className="text-[13px] text-muted">{hint}</p> : null}
      {error ? (
        <p id={errId} className="text-[13px] text-danger flex items-start gap-1">
          <XCircle aria-hidden className="size-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

const control =
  "w-full rounded-md border border-line-strong bg-surface text-ink px-3 text-sm shadow-sm placeholder:text-muted transition-colors focus:border-accent " +
  "aria-[invalid=true]:border-danger disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(control, "h-10", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest }, ref,
) {
  return <textarea ref={ref} className={cx(control, "py-2 leading-relaxed min-h-24", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest }, ref,
) {
  return (
    <select ref={ref} className={cx(control, "h-10 pr-8", className)} {...rest}>
      {children}
    </select>
  );
});

export function Checkbox({ label, hint, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className={cx("flex items-start gap-2.5", className)}>
      <input id={id} type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" aria-describedby={hint ? `${id}-h` : undefined} {...rest} />
      <div className="text-sm">
        <label htmlFor={id} className="text-ink">{label}</label>
        {hint ? <p id={`${id}-h`} className="text-[13px] text-muted mt-0.5">{hint}</p> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Badge
type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info";
const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink-2 border-line",
  accent: "bg-accent-soft text-accent border-transparent",
  ok: "bg-ok-soft text-ok border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  info: "bg-info-soft text-info border-transparent",
};
export function Badge({ tone = "neutral", children, className, icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] font-medium leading-5 max-w-full", tones[tone], className)}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

// ---------------------------------------------------------------- Layout bits
export function Card({ children, className, as: As = "section" }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" | "li" }) {
  return <As className={cx("rounded-xl border border-line bg-surface surface-premium", className)}>{children}</As>;
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between pb-6 mb-6 border-b border-line">
      <div className="min-w-0">
        {eyebrow ? <div className="text-[13px] text-muted mb-1">{eyebrow}</div> : null}
        <h1 className="serif text-3xl sm:text-[36px] leading-tight text-ink break-words">{title}</h1>
        {description ? <div className="mt-2 text-ink-2 max-w-2xl text-[15px]">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2 shrink-0">{actions}</div> : null}
    </header>
  );
}

export function SectionTitle({ children, actions, id }: { children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
      <h2 id={id} className="text-[15px] font-semibold text-ink tracking-tight">{children}</h2>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-muted">
      <Loader2 aria-hidden className="size-4 spin" />
      <span>{label}</span>
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("skeleton", className || "h-4 w-full")} />;
}

export function LoadingBlock({ label = "Loading", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={cx("h-14 w-full", i % 2 ? "opacity-70" : "")} />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-6 py-10 text-center">
      <div className="mx-auto mb-3 flex size-9 items-center justify-center rounded-full bg-surface-2 text-muted" aria-hidden>
        {icon || <CircleDashed className="size-4" />}
      </div>
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {children ? <div className="mt-1 text-sm text-muted max-w-md mx-auto">{children}</div> : null}
      {action ? <div className="mt-4 flex justify-center gap-2 flex-wrap">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = "Something went wrong" }: { error: ApiError | Error | null; onRetry?: () => void; title?: string }) {
  if (!error) return null;
  const e = error as Partial<ApiError>;
  if (e.code === "email_unverified") return <EmailUnverifiedNotice message={error.message} />;
  return (
    <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm">
      <div className="flex items-start gap-2">
        <AlertTriangle aria-hidden className="size-4 mt-0.5 text-danger shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">{title}</p>
          <p className="text-ink-2 mt-0.5 break-words">{error.message}</p>
          {e.fields && Object.keys(e.fields).length ? (
            <ul className="mt-1 list-disc pl-5 text-ink-2">
              {Object.entries(e.fields).map(([k, v]) => (
                <li key={k}><span className="font-mono text-[12px]">{k}</span>: {v}</li>
              ))}
            </ul>
          ) : null}
          {onRetry ? (
            <Button size="sm" className="mt-2" onClick={onRetry}>Try again</Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Email verification
/** "Resend link" for the email-confirmation message. Says "Sent" only when the server actually sent one. */
export function ResendVerification({ size = "sm", deliveryConfigured }: { size?: Size; deliveryConfigured?: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "sent" | "not_sent" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const resend = async () => {
    setState("busy");
    setMsg(null);
    try {
      const r = await apiFetch<{ sent: boolean }>("auth/resend-verification", { method: "POST" });
      setState(r?.sent ? "sent" : "not_sent");
    } catch (err) {
      setState("error");
      setMsg((err as ApiError)?.message || "Could not resend the link.");
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button size={size} onClick={resend} loading={state === "busy"} disabled={state === "sent"}>
        {state === "sent" ? "Sent" : "Resend link"}
      </Button>
      <span role="status" aria-live="polite" className="text-[13px] text-ink-2">
        {state === "sent" ? "Check your inbox for a new confirmation link." : null}
        {state === "not_sent" ? (deliveryConfigured === false
          ? "Email delivery isn't set up on this server, so no link was sent. Ask the person who runs this installation for help."
          : "No link was sent. Email delivery may not be set up on this server, or your address is already confirmed.") : null}
        {state === "error" ? <span className="text-danger">{msg}</span> : null}
      </span>
    </span>
  );
}

export function EmailUnverifiedNotice({ message }: { message?: string }) {
  return (
    <div role="alert" className="rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm">
      <div className="flex items-start gap-2">
        <MailWarning aria-hidden className="size-4 mt-0.5 text-warn shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">Confirm your email to continue</p>
          <p className="text-ink-2 mt-0.5 break-words">{message || "Confirm your email address to use AI analysis."}</p>
          <div className="mt-2"><ResendVerification /></div>
        </div>
      </div>
    </div>
  );
}

export function Notice({ tone = "info", title, children, className, onDismiss }: {
  tone?: "info" | "warn" | "ok" | "danger"; title?: ReactNode; children?: ReactNode; className?: string; onDismiss?: () => void;
}) {
  const Icon = tone === "warn" ? AlertTriangle : tone === "ok" ? CheckCircle2 : tone === "danger" ? XCircle : Info;
  const bg = { info: "bg-info-soft", warn: "bg-warn-soft", ok: "bg-ok-soft", danger: "bg-danger-soft" }[tone];
  const fg = { info: "text-info", warn: "text-warn", ok: "text-ok", danger: "text-danger" }[tone];
  return (
    <div className={cx("rounded-md px-3.5 py-3 text-sm flex items-start gap-2.5", bg, className)}>
      <Icon aria-hidden className={cx("size-4 mt-0.5 shrink-0", fg)} />
      <div className="min-w-0 flex-1 text-ink-2">
        {title ? <p className="font-medium text-ink">{title}</p> : null}
        {children ? <div className={title ? "mt-0.5" : ""}>{children}</div> : null}
      </div>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="text-muted hover:text-ink">
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export function DefinitionList({ items }: { items: { term: ReactNode; desc: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-[minmax(140px,200px)_1fr] gap-x-6 gap-y-2 text-sm">
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{it.term}</dt>
          <dd className="text-ink min-w-0 break-words">{it.desc}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- Tabs (ARIA tabs pattern, roving focus)
export function Tabs({ tabs, value, onChange, label }: {
  tabs: { id: string; label: ReactNode }[]; value: string; onChange: (id: string) => void; label: string;
}) {
  const onKey = (e: React.KeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    onChange(tabs[next].id);
    document.getElementById(`tab-${tabs[next].id}`)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-none">
      {tabs.map((t, i) => {
        const sel = t.id === value;
        return (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={sel}
            aria-controls={`panel-${t.id}`}
            tabIndex={sel ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={cx(
              "relative shrink-0 px-3 py-2.5 text-sm whitespace-nowrap -mb-px border-b-2",
              sel ? "border-accent text-ink font-medium" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0} className="pt-6 focus-visible:outline-offset-4">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- Chips input (free text)
export function ChipsInput({ label, values, onChange, placeholder, hint, max = 10 }: {
  label: string; values: string[]; onChange: (v: string[]) => void; placeholder?: string; hint?: string; max?: number;
}) {
  const [text, setText] = useState("");
  const id = useId();
  const add = () => {
    const v = text.trim();
    if (!v) return;
    if (!values.some((x) => x.toLowerCase() === v.toLowerCase()) && values.length < max) onChange([...values, v.slice(0, 120)]);
    setText("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {values.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${label} added`}>
          {values.map((v) => (
            <li key={v} className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface-2 pl-2.5 pr-1 py-0.5 text-[13px] max-w-full">
              <span className="truncate">{v}</span>
              <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`}
                className="rounded-full p-0.5 text-muted hover:text-ink">
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <Input id={id} value={text} placeholder={placeholder} aria-describedby={hint ? `${id}-h` : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          disabled={values.length >= max}
        />
        <Button onClick={add} disabled={!text.trim() || values.length >= max}>Add</Button>
      </div>
      <p id={`${id}-h`} className="text-[13px] text-muted">{hint ? `${hint} ` : ""}Press Enter to add. Up to {max}.</p>
    </div>
  );
}

export function ToggleGroup<T extends string>({ label, options, values, onChange }: {
  label: string; options: { id: T; label: string }[]; values: T[]; onChange: (v: T[]) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium mb-1.5">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = values.includes(o.id);
          return (
            <button key={o.id} type="button" aria-pressed={on}
              onClick={() => onChange(on ? values.filter((x) => x !== o.id) : [...values, o.id])}
              className={cx("h-9 rounded-full border px-3.5 text-sm inline-flex items-center gap-1.5",
                on ? "border-accent bg-accent-soft text-ink" : "border-line-strong bg-surface text-ink-2 hover:bg-surface-2")}>
              {on ? <CheckCircle2 aria-hidden className="size-3.5 text-accent" /> : null}
              {o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
