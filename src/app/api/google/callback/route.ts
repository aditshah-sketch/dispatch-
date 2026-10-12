import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/server/auth";
import { config } from "@/lib/server/config";
import { safeEqual, verifyPayload } from "@/lib/server/crypto";
import { getDb } from "@/lib/server/db/client";
import { emailFromIdToken, exchangeCode } from "@/lib/server/providers/google";
import { audit, markHealth } from "@/lib/server/repo/ops";
import { storeTokens } from "@/lib/server/services/google-auth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (status: string) => {
    const res = NextResponse.redirect(new URL(`/desk/settings?google=${status}`, req.url));
    res.cookies.set("dispatch_oauth", "", { path: "/api/google", maxAge: 0 });
    return res;
  };
  if (!(await getSession())) return NextResponse.redirect(new URL("/login?next=/desk/settings", req.url));
  if (url.searchParams.get("error")) return back("denied");
  const g = config.google();
  if (!g.ok) return back("not_configured");
  const state = verifyPayload<{ n: string; f: string }>(url.searchParams.get("state") ?? "", config.auth().value!.secret);
  const nonce = (await cookies()).get("dispatch_oauth")?.value ?? "";
  if (!state || !nonce || !safeEqual(state.n, nonce)) return back("invalid_state");
  const code = url.searchParams.get("code");
  if (!code) return back("missing_code");
  try {
    const tokens = await exchangeCode({ clientId: g.value!.clientId, clientSecret: g.value!.clientSecret, redirectUri: g.value!.redirectUri, code });
    const db = await getDb();
    await storeTokens(db, tokens, emailFromIdToken(tokens.idToken));
    await markHealth(db, "google", true);
    await audit(db, { actor: "owner", action: "google.connected", message: `Google connected for ${state.f} (scopes: ${tokens.scopes.map((s) => s.split("/").pop()).join(", ")}).` });
    return back("connected");
  } catch (e) {
    console.error("[google]", (e as Error).message);
    return back("failed");
  }
}
