import Link from "next/link";
import { Wordmark } from "@/components/AppShell";

const STEPS = [
  { n: "1", title: "Collect", body: "RSS feeds and news searches are gathered Monday to Wednesday. Duplicates, same-event coverage and stories from the last four editions are filtered out — with the reason shown." },
  { n: "2", title: "Review", body: "On Wednesday afternoon Gemini Flash proposes 8–10 stories across at least three topics, with two or three sentences of commentary in your style. Edit, swap or remove anything." },
  { n: "3", title: "Approve", body: "You confirm one exact revision, on the dashboard or in Telegram. Any later edit withdraws the approval. Silence never sends anything — a 10 PM reminder just asks." },
  { n: "4", title: "Deliver", body: "The approved snapshot is sent through Gmail on Thursday morning, recipient by recipient, with unsubscribes and bounces handled separately." },
];

export default function Home() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-5 py-8 sm:px-8 sm:py-12">
      <header className="flex items-center justify-between">
        <Wordmark />
        <Link href="/login" className="text-sm font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline">
          Owner sign in
        </Link>
      </header>

      <main className="flex-1">
        <section className="py-16 sm:py-24">
          <p className="mb-4 text-[12px] font-semibold uppercase tracking-[0.14em] text-accent">Newsletter intelligence engine</p>
          <h1 className="max-w-3xl font-serif text-[42px] font-semibold leading-[1.05] tracking-[-0.015em] sm:text-[60px]">
            The research gets done. <span className="italic text-ink-2">The judgement stays yours.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-[17px] leading-relaxed text-ink-2">
            A weekly desk for a curated newsletter about India&apos;s startup ecosystem. It does the collecting, filtering and first drafting,
            so the editor&apos;s time goes into choosing what matters and saying why.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Link href="/preview" className="inline-flex h-12 items-center justify-center rounded-md bg-accent px-6 text-[15px] font-medium text-white hover:bg-accent-strong">
              Open the interactive preview
            </Link>
            <Link href="/login" className="inline-flex h-12 items-center justify-center rounded-md border border-rule-strong bg-surface px-6 text-[15px] font-medium hover:bg-sunk">
              Go to the live desk
            </Link>
          </div>
          <p className="mt-3 text-[13px] text-ink-3">
            The preview uses fictional sample articles stored only in your browser. It never fetches, emails, messages or books anything.
          </p>
        </section>

        <section aria-labelledby="how" className="border-t border-rule py-14">
          <h2 id="how" className="mb-8 font-serif text-[26px] font-semibold">How a week works</h2>
          <ol className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <li key={s.n}>
                <div className="mb-2 font-serif text-[30px] font-semibold text-accent">{s.n}</div>
                <h3 className="mb-1.5 text-[15px] font-semibold">{s.title}</h3>
                <p className="text-[14px] leading-relaxed text-ink-2">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="border-t border-rule pt-6 text-[12.5px] text-ink-3">
        AI tasks use Google Gemini Flash. Optional follow-up meetings are only booked after an explicit “Confirm and book”.
      </footer>
    </div>
  );
}
