import { NextResponse, type NextRequest } from "next/server";
import { callAuth } from "@/lib/server/session";
import { FLOW_COOKIE, callbackUrl, publicOrigin, secure } from "../_flow";

export const dynamic = "force-dynamic";

/** "Continue with Google": get a fresh authorization URL from the API and send the browser to Google. */
export async function GET(req: NextRequest) {
  const redirect_uri = callbackUrl(req);
  const { status, json } = await callAuth("google/start", { redirect_uri });
  const s = json as { url?: string; state?: string; nonce?: string; verifier?: string } | null;
  if (status !== 200 || !s?.url || !s.state || !s.nonce || !s.verifier) {
    const code = (json as { error?: { code?: string } } | null)?.error?.code || "google_unavailable";
    return NextResponse.redirect(`${publicOrigin(req)}/login?google_error=${encodeURIComponent(code)}`, 303);
  }
  const tz = (req.nextUrl.searchParams.get("tz") || "UTC").slice(0, 64);
  const res = NextResponse.redirect(s.url, 303);
  res.cookies.set(FLOW_COOKIE, Buffer.from(JSON.stringify({ s: s.state, n: s.nonce, v: s.verifier, tz })).toString("base64url"), {
    httpOnly: true, sameSite: "lax", secure: secure(), path: "/api/session/google", maxAge: 600,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
