import { NextResponse, type NextRequest } from "next/server";

// Fast gate for the owner area: requests without a session cookie never reach
// the live desk. The cookie's signature is verified in the route handlers and
// the desk layout (proxy should stay light and free of shared server modules).
export function proxy(request: NextRequest) {
  if (request.cookies.has("dispatch_session")) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: { code: "AUTH", message: "Please sign in." } }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/desk/:path*", "/api/desk/:path*"],
};
