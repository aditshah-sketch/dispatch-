import { NextResponse } from "next/server";
import { getSession } from "@/lib/server/auth";
import { config } from "@/lib/server/config";
import { randomToken, signPayload } from "@/lib/server/crypto";
import { buildAuthUrl, type GoogleFeature } from "@/lib/server/providers/google";

const FEATURES: GoogleFeature[] = ["send", "feedback", "calendar"];

export async function GET(req: Request) {
  if (!(await getSession())) return NextResponse.redirect(new URL("/login?next=/desk/settings", req.url));
  const g = config.google();
  if (!g.ok) return NextResponse.redirect(new URL(`/desk/settings?google=not_configured`, req.url));
  const feature = new URL(req.url).searchParams.get("feature") as GoogleFeature;
  if (!FEATURES.includes(feature)) return NextResponse.redirect(new URL("/desk/settings", req.url));
  // State = signed {nonce, feature, exp}; the nonce is also bound to this browser via cookie.
  const nonce = randomToken(16);
  const state = signPayload({ n: nonce, f: feature, exp: Date.now() + 10 * 60_000 }, config.auth().value!.secret);
  const res = NextResponse.redirect(buildAuthUrl({ clientId: g.value!.clientId, redirectUri: g.value!.redirectUri, feature, state }));
  res.cookies.set("dispatch_oauth", nonce, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/google", maxAge: 600 });
  return res;
}
