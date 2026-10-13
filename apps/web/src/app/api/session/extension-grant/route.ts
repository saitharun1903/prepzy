import { NextResponse, type NextRequest } from "next/server";
import {
  ACCESS_COOKIE, REFRESH_COOKIE, callAuth, checkCsrf, clearSessionCookies, errorJson, refreshSession, setSessionCookies,
} from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Issues an extension refresh token for the signed-in web session. The page hands it directly to the
 * extension via chrome.runtime.sendMessage; it is never stored by this web app. */
export async function POST(req: NextRequest) {
  const blocked = checkCsrf(req);
  if (blocked) return blocked;
  let at = req.cookies.get(ACCESS_COOKIE)?.value;
  const rt = req.cookies.get(REFRESH_COOKIE)?.value;
  let refreshed: Awaited<ReturnType<typeof refreshSession>> | null = null;
  if (!at && rt) {
    refreshed = await refreshSession(rt);
    if (refreshed.ok) at = refreshed.tokens.access_token;
  }
  if (!at) {
    const res = errorJson(401, "unauthenticated", "Sign in again to connect the extension.");
    clearSessionCookies(res);
    return res;
  }
  let r = await callAuth("extension-grant", {}, at);
  const code = (r.json as { error?: { code?: string } } | null)?.error?.code;
  if (r.status === 401 && code === "token_expired" && rt && !refreshed) {
    refreshed = await refreshSession(rt);
    if (refreshed.ok) r = await callAuth("extension-grant", {}, refreshed.tokens.access_token);
  }
  const res = NextResponse.json(r.json, { status: r.status, headers: { "Cache-Control": "no-store" } });
  if (refreshed?.ok) setSessionCookies(res, refreshed.tokens);
  else if (r.status === 401) clearSessionCookies(res);
  return res;
}
