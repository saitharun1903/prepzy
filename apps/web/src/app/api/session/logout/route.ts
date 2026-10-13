import { NextResponse, type NextRequest } from "next/server";
import { REFRESH_COOKIE, callAuth, checkCsrf, clearSessionCookies } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const blocked = checkCsrf(req);
  if (blocked) return blocked;
  const rt = req.cookies.get(REFRESH_COOKIE)?.value;
  if (rt) await callAuth("logout", { refresh_token: rt });
  const res = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  clearSessionCookies(res);
  return res;
}
