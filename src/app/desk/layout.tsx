import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell, Wordmark } from "@/components/AppShell";
import { DispatchProvider } from "@/lib/client/context";
import { getSession } from "@/lib/server/auth";
import { config } from "@/lib/server/config";
import { getDb } from "@/lib/server/db/client";

export const metadata: Metadata = { title: { default: "Desk", template: "%s · The Dispatch" } };

function Setup({ problems }: { problems: string[] }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-5">
      <Wordmark />
      <h1 className="mt-6 font-serif text-3xl font-semibold">The live desk isn&apos;t set up yet</h1>
      <p className="mt-2 text-ink-2">Connected mode needs durable storage and owner sign-in. Everything else can be connected later, one integration at a time.</p>
      <ul className="mt-5 list-disc space-y-1.5 pl-5 text-sm text-ink-2">
        {problems.map((p) => <li key={p}>{p}</li>)}
      </ul>
      <p className="mt-5 text-sm text-ink-2">See <code>.env.example</code> and the README for each variable. Meanwhile the <Link className="font-medium text-accent underline" href="/preview">preview</Link> runs the whole journey with sample data.</p>
    </div>
  );
}

export default async function DeskLayout({ children }: { children: React.ReactNode }) {
  const problems: string[] = [];
  if (!config.database().ok) problems.push("Set DATABASE_URL (any Postgres; locally you can use pglite:./.data/dispatch).");
  if (!config.auth().ok) problems.push(`Set ${config.auth().missing.join(" and ")} for owner sign-in.`);
  if (problems.length) return <Setup problems={problems} />;
  if (!(await getSession())) redirect("/login?next=/desk");
  try {
    await getDb();
  } catch (e) {
    return <Setup problems={[`The database couldn't be opened: ${(e as Error).message}`]} />;
  }
  return (
    <DispatchProvider mode="live">
      <AppShell>{children}</AppShell>
    </DispatchProvider>
  );
}
