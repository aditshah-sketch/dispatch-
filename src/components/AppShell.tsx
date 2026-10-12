"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useDispatch } from "@/lib/client/context";
import { Button, Dialog } from "./ui";

const NAV = [
  { href: "", label: "This Week" },
  { href: "/articles", label: "Articles" },
  { href: "/archive", label: "Archive" },
  { href: "/audience", label: "Audience" },
  { href: "/settings", label: "Settings" },
];

export function Wordmark({ small }: { small?: boolean }) {
  return (
    <span className={clsx("font-serif font-semibold tracking-[-0.01em] text-ink", small ? "text-xl" : "text-2xl")}>
      The Dispatch
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { base, mode, toasts, dismiss, run } = useDispatch();
  const pathname = usePathname();
  const [resetOpen, setResetOpen] = useState(false);
  const isActive = (href: string) => (href === "" ? pathname === base : pathname.startsWith(base + href));

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-rule bg-paper px-5 py-6 lg:flex">
        <Link href={base} className="mb-1 rounded-sm">
          <Wordmark />
        </Link>
        <p className="mb-8 text-[12px] text-ink-3">Newsletter desk</p>
        <nav aria-label="Main" className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={base + n.href}
              aria-current={isActive(n.href) ? "page" : undefined}
              className={clsx(
                "rounded-md px-3 py-2 text-[14px] font-medium transition-colors",
                isActive(n.href) ? "bg-surface text-ink shadow-[inset_2px_0_0_var(--color-accent)]" : "text-ink-2 hover:bg-sunk hover:text-ink",
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto space-y-3 text-[12px] text-ink-3">
          {mode === "preview" ? (
            <div className="rounded-md border border-warn/25 bg-warn-soft px-3 py-2.5 text-warn">
              <p className="font-semibold">Preview mode</p>
              <p className="mt-0.5 text-ink-2">Fictional sample data, stored only in this browser.</p>
              <button onClick={() => setResetOpen(true)} className="mt-1.5 font-medium text-accent underline-offset-2 hover:underline">
                Reset preview
              </button>
            </div>
          ) : (
            <form action="/api/auth/logout" method="post">
              <button className="text-ink-3 underline-offset-2 hover:text-ink hover:underline">Sign out</button>
            </form>
          )}
        </div>
      </aside>

      <div className="min-w-0">
        {/* Mobile top bar */}
        <div className="sticky top-0 z-20 border-b border-rule bg-paper/95 backdrop-blur lg:hidden">
          <div className="flex items-center justify-between px-4 pt-3">
            <Link href={base}>
              <Wordmark small />
            </Link>
            {mode === "preview" ? (
              <button onClick={() => setResetOpen(true)} className="text-[12px] font-medium text-accent">
                Reset preview
              </button>
            ) : (
              <form action="/api/auth/logout" method="post">
                <button className="text-[12px] text-ink-3">Sign out</button>
              </form>
            )}
          </div>
          <nav aria-label="Main" className="scrollbar-thin flex gap-1 overflow-x-auto px-3 py-2">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={base + n.href}
                aria-current={isActive(n.href) ? "page" : undefined}
                className={clsx(
                  "shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium",
                  isActive(n.href) ? "bg-ink text-paper" : "text-ink-2 hover:bg-sunk",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </div>

        {mode === "preview" && (
          <div className="border-b border-warn/20 bg-warn-soft/70 px-4 py-2 text-[13px] text-ink-2 sm:px-8">
            <span className="font-semibold text-warn">Preview · sample data.</span> Companies and articles are fictional. Nothing is fetched,
            emailed, posted to Telegram or added to a calendar — those results are marked <em>simulated</em>.
          </div>
        )}

        <main id="main" className="mx-auto w-full max-w-[1080px] px-4 py-8 sm:px-8 sm:py-10">
          {children}
        </main>
      </div>

      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end sm:px-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={clsx(
              "animate-fade-in pointer-events-auto flex max-w-md items-start gap-3 rounded-lg border px-4 py-3 text-[13.5px] shadow-[0_8px_24px_-8px_rgb(0_0_0/0.25)]",
              t.tone === "error" ? "border-bad/30 bg-surface text-bad" : "border-rule bg-ink text-paper",
            )}
          >
            <span className="flex-1">
              {t.simulated && <span className="mr-1.5 rounded bg-warn-soft px-1.5 py-0.5 text-[11px] font-semibold text-warn">Simulated</span>}
              {t.text}
            </span>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
              ×
            </button>
          </div>
        ))}
      </div>

      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset the preview?"
        description="This clears your sample edits in this browser and starts again from the sample collection."
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                await run("resetPreview", {});
                setResetOpen(false);
              }}
            >
              Reset preview
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">Only preview data is affected. There is no live data in preview mode.</p>
      </Dialog>
    </div>
  );
}
