import { NextResponse, type NextRequest } from "next/server";
import { callAuth, checkCsrf, errorJson, setSessionCookies, type TokenOut } from "@/lib/server/session";

const NO_STORE = { "Cache-Control": "no-store" };

async function readBody(req: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  try {
    const b = (await req.json()) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return errorJson(400, "invalid_body", "Request body must be JSON.");
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function passError(status: number, json: unknown, fallback: string): NextResponse {
  return NextResponse.json(json ?? { error: { code: "auth_failed", message: fallback, request_id: null, retryable: false, fields: {} } }, {
    status, headers: NO_STORE,
  });
}

/** Set HttpOnly cookies from a TokenOut and return only the user. */
function signedIn(t: TokenOut): NextResponse {
  const res = NextResponse.json({ user: t.user }, { status: 200, headers: NO_STORE });
  setSessionCookies(res, t);
  return res;
}

/** Shared login/register flow: call the API, set HttpOnly cookies, return only the user.
 * A login for an account with two-step verification returns a short-lived challenge instead:
 * no cookies are set and the page completes the sign-in through /api/session/login/mfa. */
export async function authenticate(req: NextRequest, path: "login" | "register"): Promise<NextResponse> {
  const blocked = checkCsrf(req);
  if (blocked) return blocked;
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  const payload: Record<string, unknown> = { email: str(body.email), password: str(body.password), client: "web" };
  if (path === "register") {
    if (typeof body.display_name === "string" && body.display_name.trim()) payload.display_name = body.display_name.trim();
    if (typeof body.timezone === "string" && body.timezone) payload.timezone = body.timezone;
  }
  const { status, json } = await callAuth(path, payload);
  if (status < 200 || status >= 300) return passError(status, json, "Sign-in failed.");
  const challenge = json as { mfa_required?: boolean; mfa_token?: string; expires_in?: number };
  if (path === "login" && challenge?.mfa_required === true && typeof challenge.mfa_token === "string") {
    return NextResponse.json(
      { mfa_required: true, mfa_token: challenge.mfa_token, expires_in: challenge.expires_in ?? 300 },
      { status: 200, headers: NO_STORE },
    );
  }
  return signedIn(json as TokenOut);
}

/** Second sign-in step: exchange the challenge + authenticator/recovery code for a session. */
export async function completeMfa(req: NextRequest): Promise<NextResponse> {
  const blocked = checkCsrf(req);
  if (blocked) return blocked;
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  const { status, json } = await callAuth("login/mfa", { mfa_token: str(body.mfa_token), code: str(body.code).trim() });
  if (status < 200 || status >= 300) return passError(status, json, "Sign-in failed.");
  return signedIn(json as TokenOut);
}

/** Unauthenticated account-recovery calls (forgot/reset password, verify email). Only the named
 * fields are forwarded; tokens are never logged and responses are never cached. */
export async function publicAuth(req: NextRequest, path: string, fields: string[]): Promise<NextResponse> {
  const blocked = checkCsrf(req);
  if (blocked) return blocked;
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  const payload: Record<string, string> = {};
  for (const f of fields) payload[f] = str(body[f]);
  const { status, json } = await callAuth(path, payload);
  if (status < 200 || status >= 300) return passError(status, json, "The request failed.");
  if (status === 204 || json === null) return new NextResponse(null, { status: 204, headers: NO_STORE });
  return NextResponse.json(json, { status, headers: NO_STORE });
}
