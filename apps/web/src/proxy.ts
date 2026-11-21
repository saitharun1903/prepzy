import { clientIpOf } from "@/lib/client-ip";
import { NextResponse, type NextRequest } from "next/server";

/** Next 16 "proxy" (formerly middleware): per-request CSP nonce + optimistic auth redirects.
 * Real authorization happens at the API; this only decides which page to show. */

const PUBLIC_PATHS = ["/welcome", "/login", "/register", "/privacy", "/forgot-password", "/reset-password", "/verify-email"];

function csp(nonce: string): string {
  const dev = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Inline style attributes are used by React/motion; scripts remain nonce-locked.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // Public API paths (extension, health checks) forwarded to the local API: replace any client-sent
  // X-Forwarded-For with the edge-verified visitor IP so rate limits cannot be spoofed or shared.
  if (pathname.startsWith("/api/v1/") || pathname.startsWith("/health/")) {
    const h = new Headers(request.headers);
    const ip = clientIpOf(request.headers);
    if (ip) h.set("x-forwarded-for", ip);
    else h.delete("x-forwarded-for");
    return NextResponse.next({ request: { headers: h } });
  }
  // A retired deployment (e.g. the old elevate-web address) sends every visitor to the new site.
  const moved = process.env.ELEVATE_REDIRECT_ORIGIN;
  if (moved && /^https:\/\/[a-z0-9.-]+$/i.test(moved)) {
    return NextResponse.redirect(`${moved}${pathname}${search}`, 308);
  }
  const hasSession = Boolean(request.cookies.get("el_at")?.value || request.cookies.get("el_s")?.value);
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!isPublic && !hasSession) {
    const url = request.nextUrl.clone();
    // A signed-out visitor to the home page sees the welcome page; deep links go to sign-in and come back.
    url.pathname = pathname === "/" ? "/welcome" : "/login";
    url.search = pathname !== "/" ? `?next=${encodeURIComponent(pathname + search)}` : "";
    return NextResponse.redirect(url);
  }
  if ((pathname === "/login" || pathname === "/register" || pathname === "/welcome") && hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = csp(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: [
    "/api/v1/:path*",
    "/health/:path*",
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|icon.svg|downloads/|fonts/|templates/|landing/|health/|metrics$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
