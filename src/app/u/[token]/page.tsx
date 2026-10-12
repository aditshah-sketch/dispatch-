import type { Metadata } from "next";
import { Wordmark } from "@/components/AppShell";
import { getDb } from "@/lib/server/db/client";
import { maskEmail, resolveUnsubscribeToken } from "@/lib/server/services/unsubscribe";

export const metadata: Metadata = { title: "Unsubscribe" };

export default async function UnsubscribePage(props: PageProps<"/u/[token]">) {
  const { token } = await props.params;
  const sp = await props.searchParams;
  let sub: Awaited<ReturnType<typeof resolveUnsubscribeToken>> = null;
  try {
    sub = await resolveUnsubscribeToken(await getDb(), token);
  } catch {
    sub = null;
  }
  const done = sp.done === "1" || sub?.status === "UNSUBSCRIBED";

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-rule bg-surface p-7 text-center">
        <Wordmark />
        {!sub ? (
          <p className="mt-6 text-ink-2">This unsubscribe link isn&apos;t valid. If you keep receiving emails you don&apos;t want, reply to one and ask to be removed.</p>
        ) : done ? (
          <>
            <h1 className="mt-6 font-serif text-2xl font-semibold">You&apos;re unsubscribed</h1>
            <p className="mt-2 text-ink-2">{maskEmail(sub.email)} won&apos;t receive The Dispatch any more.</p>
          </>
        ) : (
          <>
            <h1 className="mt-6 font-serif text-2xl font-semibold">Unsubscribe?</h1>
            <p className="mt-2 text-ink-2">Stop sending The Dispatch to {maskEmail(sub.email)}.</p>
            <form action={`/api/unsubscribe/${encodeURIComponent(token)}`} method="post" className="mt-6">
              <button className="h-11 w-full rounded-md bg-accent px-5 font-medium text-white hover:bg-accent-strong">Unsubscribe</button>
            </form>
            <p className="mt-3 text-[12.5px] text-ink-3">No account or login needed.</p>
          </>
        )}
      </div>
    </div>
  );
}
