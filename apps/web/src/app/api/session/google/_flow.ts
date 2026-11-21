import type { NextRequest } from "next/server";

/** One-time values for a single Google sign-in, kept in a short-lived HttpOnly cookie between the redirect to
 * Google and the callback (state = CSRF protection, nonce = replay protection, verifier = PKCE). */
export const FLOW_COOKIE = "el_g";
export const MFA_COOKIE = "el_mfa";
export const secure = () => process.env.NODE_ENV === "production";

export function publicOrigin(req: NextRequest): string {
  return (process.env.ELEVATE_WEB_URL || req.nextUrl.origin).replace(/\/+$/, "");
}

export const callbackUrl = (req: NextRequest) => `${publicOrigin(req)}/api/session/google/callback`;
