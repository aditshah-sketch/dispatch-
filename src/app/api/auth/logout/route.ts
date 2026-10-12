import { NextResponse } from "next/server";
import { SESSION_COOKIE, sameOrigin } from "@/lib/server/auth";

export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL("/", req.url), 303);
  if (sameOrigin(req)) res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
