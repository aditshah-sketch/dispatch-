import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/AppShell";
import { getSession } from "@/lib/server/auth";
import { config } from "@/lib/server/config";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  invalid: "That password isn't right.",
  rate: "Too many attempts. Wait 15 minutes and try again.",
  config: "Owner sign-in isn't configured on this deployment yet.",
  csrf: "Your sign-in request was blocked. Reload the page and try again.",
};

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/desk") ? sp.next : "/desk";
  if (await getSession()) redirect(next);
  const error = typeof sp.error === "string" ? ERRORS[sp.error] : null;
  const configured = config.auth().ok;

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 block text-center"><Wordmark /></Link>
        <div className="rounded-xl border border-rule bg-surface p-6 shadow-[0_12px_32px_-16px_rgb(0_0_0/0.18)]">
          <h1 className="font-serif text-2xl font-semibold">Owner sign in</h1>
          <p className="mt-1 text-sm text-ink-2">The live desk holds real drafts, subscribers and integrations.</p>
          {!configured ? (
            <div className="mt-5 rounded-md border border-warn/30 bg-warn-soft p-3 text-sm text-ink-2">
              Set <code>AUTH_SECRET</code> and <code>OWNER_PASSWORD</code> (and a <code>DATABASE_URL</code>) to enable the live desk. Until then, the{" "}
              <Link href="/preview" className="font-medium text-accent underline">preview</Link> shows the full journey with sample data.
            </div>
          ) : (
            <form action="/api/auth/login" method="post" className="mt-5 space-y-4">
              <input type="hidden" name="next" value={next} />
              <div className="flex flex-col gap-1.5">
                <label htmlFor="password" className="text-[13px] font-medium">Password</label>
                <input id="password" name="password" type="password" required autoComplete="current-password" autoFocus
                  aria-invalid={!!error || undefined} aria-describedby={error ? "login-error" : undefined}
                  className="h-10 rounded-md border border-rule-strong bg-surface px-3 text-[14px] focus:border-accent focus:outline-none" />
                {error && <p id="login-error" role="alert" className="text-[12.5px] text-bad">{error}</p>}
              </div>
              <button className="h-10 w-full rounded-md bg-accent text-sm font-medium text-white hover:bg-accent-strong">Sign in</button>
            </form>
          )}
        </div>
        <p className="mt-6 text-center text-[13px] text-ink-3">
          Just looking? <Link href="/preview" className="font-medium text-accent underline-offset-4 hover:underline">Open the preview</Link>
        </p>
      </div>
    </div>
  );
}
