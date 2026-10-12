import "server-only";
import { cookies } from "next/headers";
import { config } from "./config";
import { hmac, safeEqual, signPayload, verifyPayload } from "./crypto";

// Single-owner authentication: a password from the environment, exchanged for
// a signed, HTTP-only session cookie. Simple to explain and adequate for one
// editor; the public preview never needs it.

export const SESSION_COOKIE = "dispatch_session";
const SESSION_DAYS = 14;

export interface Session {
  sub: "owner";
  name: string;
  iat: number;
  exp: number;
}

export function checkPassword(candidate: string): boolean {
  const a = config.auth();
  if (!a.ok) return false;
  // Compare HMACs so the comparison is constant-time regardless of length.
  return safeEqual(hmac(candidate, a.value!.secret, 43), hmac(a.value!.password, a.value!.secret, 43));
}

export function createSessionToken(): string {
  const a = config.auth().value!;
  const now = Date.now();
  return signPayload({ sub: "owner", name: a.ownerName, iat: now, exp: now + SESSION_DAYS * 86_400_000 }, a.secret);
}

export function readSessionToken(token: string | undefined): Session | null {
  const a = config.auth();
  if (!a.ok || !token) return null;
  return verifyPayload<Session & Record<string, unknown>>(token, a.value!.secret) as Session | null;
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  return readSessionToken(jar.get(SESSION_COOKIE)?.value);
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_DAYS * 86_400,
};

// CSRF defence in depth for cookie-authenticated mutations (SameSite=Lax
// already blocks cross-site POSTs in modern browsers).
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  try {
    return new URL(origin).host === new URL(req.url).host || origin === config.baseUrl();
  } catch {
    return false;
  }
}
