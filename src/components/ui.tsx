"use client";

import clsx from "clsx";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

// ---------- Button ----------

type Variant = "primary" | "secondary" | "ghost" | "danger" | "quiet";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; busy?: boolean; busyLabel?: string }
>(function Button({ variant = "secondary", size = "md", busy, busyLabel, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors select-none",
        "disabled:cursor-not-allowed disabled:opacity-55",
        size === "sm" && "h-8 px-3 text-[13px]",
        size === "md" && "h-10 px-4 text-sm",
        size === "lg" && "h-12 px-6 text-[15px]",
        variant === "primary" && "bg-accent text-white hover:bg-accent-strong shadow-[0_1px_0_rgb(0_0_0/0.08)]",
        variant === "secondary" && "border border-rule-strong bg-surface text-ink hover:bg-sunk",
        variant === "ghost" && "text-ink-2 hover:bg-sunk hover:text-ink",
        variant === "quiet" && "text-accent hover:text-accent-strong underline-offset-4 hover:underline px-1",
        variant === "danger" && "border border-bad/30 bg-surface text-bad hover:bg-bad-soft",
        className,
      )}
      {...rest}
    >
      {busy ? (
        <>
          <Spinner className={variant === "primary" ? "text-white" : "text-ink-3"} />
          <span>{busyLabel ?? children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
});

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-2", className)} role={label ? "status" : undefined}>
      <span aria-hidden className="inline-block size-3.5 rounded-full border-2 border-current border-r-transparent [animation:spin_.8s_linear_infinite]" />
      {label && <span className="text-sm text-ink-2">{label}</span>}
    </span>
  );
}

// ---------- Badges & status ----------

export type Tone = "neutral" | "accent" | "ok" | "warn" | "bad" | "info";

const toneClass: Record<Tone, string> = {
  neutral: "bg-sunk text-ink-2 border-rule",
  accent: "bg-accent-soft text-accent-strong border-accent/20",
  ok: "bg-ok-soft text-ok border-ok/20",
  warn: "bg-warn-soft text-warn border-warn/25",
  bad: "bg-bad-soft text-bad border-bad/20",
  info: "bg-info-soft text-info border-info/20",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11.5px] font-medium leading-4 whitespace-nowrap", toneClass[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ tone = "neutral" }: { tone?: Tone }) {
  const c = { neutral: "bg-ink-3", accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info" }[tone];
  return <span aria-hidden className={clsx("inline-block size-2 shrink-0 rounded-full", c)} />;
}

// ---------- Layout ----------

export function Card({ children, className, as: As = "section", ...rest }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" } & Record<string, unknown>) {
  return (
    <As className={clsx("rounded-lg border border-rule bg-surface", className)} {...rest}>
      {children}
    </As>
  );
}

export function SectionTitle({ children, action, id, sub }: { children: ReactNode; action?: ReactNode; id?: string; sub?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div>
        <h2 id={id} className="font-serif text-[22px] font-semibold leading-tight text-ink">
          {children}
        </h2>
        {sub && <p className="mt-1 text-sm text-ink-3">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ eyebrow, title, children, actions }: { eyebrow?: ReactNode; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-accent">{eyebrow}</div>}
        <h1 className="font-serif text-[34px] font-semibold leading-[1.1] tracking-[-0.01em] text-ink sm:text-[40px]">{title}</h1>
        {children && <div className="mt-2 text-[15px] text-ink-2">{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-rule-strong bg-surface/60 px-6 py-10 text-center">
      <p className="font-serif text-lg font-semibold text-ink">{title}</p>
      {children && <div className="mx-auto mt-1.5 max-w-md text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Callout({ tone = "info", title, children, action }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={clsx("flex flex-col gap-2 rounded-md border px-4 py-3 text-sm sm:flex-row sm:items-start sm:justify-between", toneClass[tone])}>
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={clsx("text-ink-2", title && "mt-0.5")}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Callout tone="bad" title="Couldn't load this page" action={onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>}>
      {message}
    </Callout>
  );
}

export function LoadingBlock({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center">
      <Spinner label={label} className="text-ink-3" />
    </div>
  );
}

// ---------- Form fields ----------

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[12.5px] text-bad" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12.5px] text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

const inputBase =
  "w-full rounded-md border border-rule-strong bg-surface px-3 text-[14px] text-ink placeholder:text-ink-3/70 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-accent/40 disabled:bg-sunk";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ className, invalid, ...rest }, ref) {
  return <input ref={ref} aria-invalid={invalid || undefined} className={clsx(inputBase, "h-10", invalid && "border-bad", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; autoGrow?: boolean }>(function Textarea(
  { className, invalid, autoGrow, ...rest },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!autoGrow || !inner.current) return;
    const el = inner.current;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  });
  return (
    <textarea
      ref={(el) => {
        inner.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      aria-invalid={invalid || undefined}
      className={clsx(inputBase, "py-2 leading-relaxed", autoGrow && "resize-none overflow-hidden", invalid && "border-bad", className)}
      {...rest}
    />
  );
});

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(inputBase, "h-10 pr-8", className)} {...rest}>
      {children}
    </select>
  );
}

// ---------- Dialog (native <dialog> for focus handling and Esc) ----------

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg" | "xl";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={clsx(
        "m-auto max-h-[92dvh] w-[calc(100%-24px)] overflow-hidden rounded-xl border border-rule bg-surface p-0 text-ink shadow-[0_24px_64px_-16px_rgb(0_0_0/0.35)]",
        size === "md" && "max-w-lg",
        size === "lg" && "max-w-2xl",
        size === "xl" && "max-w-5xl",
      )}
    >
      {open && (
        <div className="flex max-h-[92dvh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-rule px-5 py-4">
            <div>
              <h2 id={titleId} className="font-serif text-xl font-semibold leading-snug">
                {title}
              </h2>
              {description && <div className="mt-1 text-sm text-ink-2">{description}</div>}
            </div>
            <button onClick={onClose} className="-mr-1 rounded p-1 text-ink-3 hover:bg-sunk hover:text-ink" aria-label="Close">
              <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="scrollbar-thin overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule bg-paper/60 px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function Disclosure({ summary, children, className }: { summary: ReactNode; children: ReactNode; className?: string }) {
  return (
    <details className={clsx("group", className)}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-ink-3 hover:text-ink [&::-webkit-details-marker]:hidden">
        <svg className="size-3 transition-transform group-open:rotate-90" viewBox="0 0 12 12" aria-hidden>
          <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={clsx("mt-1 font-serif text-[26px] font-semibold leading-none", tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-ink")}>{value}</div>
      {sub && <div className="mt-1.5 text-[12.5px] leading-snug text-ink-3">{sub}</div>}
    </div>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const safe = /^https?:\/\//i.test(href) ? href : undefined;
  if (!safe) return <span className={className}>{children}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className={clsx("underline-offset-4 hover:underline", className)}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
