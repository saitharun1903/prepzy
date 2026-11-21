import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { callAuth, setSessionCookies, type TokenOut } from "@/lib/server/session";
import { FLOW_COOKIE, MFA_COOKIE, callbackUrl, publicOrigin, secure } from "../_flow";

export const dynamic = "force-dynamic";

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Google sends the browser back here with a one-time code. Check state, let the API verify everything with
 * Google, then set the same HttpOnly session cookies as a password sign-in. */
export async function GET(req: NextRequest) {
  const origin = publicOrigin(req);
  const fail = (code: string) => {
    const r = NextResponse.redirect(`${origin}/login?google_error=${encodeURIComponent(code)}`, 303);
    r.cookies.set(FLOW_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: secure(), path: "/api/session/google", maxAge: 0 });
    return r;
  };
  const q = req.nextUrl.searchParams;
  if (q.get("error")) return fail(q.get("error") === "access_denied" ? "google_cancelled" : "google_failed");
  let flow: { s?: string; n?: string; v?: string; tz?: string } = {};
  try { flow = JSON.parse(Buffer.from(req.cookies.get(FLOW_COOKIE)?.value || "", "base64url").toString("utf8")); } catch { flow = {}; }
  const code = q.get("code") || "", state = q.get("state") || "";
  if (!code || !flow.s || !flow.n || !flow.v || !same(state, flow.s)) return fail("google_expired");

  const { status, json } = await callAuth("google/callback", {
    code, verifier: flow.v, nonce: flow.n, redirect_uri: callbackUrl(req), client: "web", timezone: flow.tz || "UTC",
  });
  if (status < 200 || status >= 300) return fail((json as { error?: { code?: string } } | null)?.error?.code || "google_failed");

  const out = json as (TokenOut & { mfa_required?: undefined }) | { mfa_required: true; mfa_token: string; expires_in: number };
  if ("mfa_required" in out && out.mfa_required) {
    // Two-step verification still applies: the login page asks for the code; the challenge stays in a cookie.
    const r = NextResponse.redirect(`${origin}/login?mfa=google`, 303);
    r.cookies.set(MFA_COOKIE, out.mfa_token, { httpOnly: true, sameSite: "strict", secure: secure(), path: "/api/session", maxAge: out.expires_in || 300 });
    r.cookies.set(FLOW_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: secure(), path: "/api/session/google", maxAge: 0 });
    return r;
  }
  const r = NextResponse.redirect(`${origin}/`, 303);
  setSessionCookies(r, out as TokenOut);
  r.cookies.set(FLOW_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: secure(), path: "/api/session/google", maxAge: 0 });
  r.headers.set("Cache-Control", "no-store");
  return r;
}
