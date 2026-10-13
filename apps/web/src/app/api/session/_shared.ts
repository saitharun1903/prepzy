import { NextResponse, type NextRequest } from "next/server";
import { callAuth, checkCsrf, errorJson, setSessionCookies, type TokenOut } from "@/lib/server/session";

/** Shared login/register flow: call the API, set HttpOnly cookies, return only the user. */
export async function authenticate(req: NextRequest, path: "login" | "register"): Promise<NextResponse> {
  const blocked = checkCsrf(req);
  if (blocked) return blocked;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorJson(400, "invalid_body", "Request body must be JSON.");
  }
  const payload: Record<string, unknown> = {
    email: typeof body.email === "string" ? body.email : "",
    password: typeof body.password === "string" ? body.password : "",
    client: "web",
  };
  if (path === "register") {
    if (typeof body.display_name === "string" && body.display_name.trim()) payload.display_name = body.display_name.trim();
    if (typeof body.timezone === "string" && body.timezone) payload.timezone = body.timezone;
  }
  const { status, json } = await callAuth(path, payload);
  if (status < 200 || status >= 300) {
    return NextResponse.json(json ?? { error: { code: "auth_failed", message: "Sign-in failed.", fields: {} } }, {
      status, headers: { "Cache-Control": "no-store" },
    });
  }
  const t = json as TokenOut;
  const res = NextResponse.json({ user: t.user }, { status: 200, headers: { "Cache-Control": "no-store" } });
  setSessionCookies(res, t);
  return res;
}
