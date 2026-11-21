import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/auth-form";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

/** The Google button shows only when the server has its Google OAuth client (keys stay server-side). */
const googleEnabled = () => Boolean(process.env.ELEVATE_GOOGLE_CLIENT_ID && process.env.ELEVATE_GOOGLE_CLIENT_SECRET);

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const err = one("google_error");
  return <AuthForm mode="login" next={one("next")} googleEnabled={googleEnabled()}
    googleError={err && /^[a-z_]{1,40}$/.test(err) ? err : undefined} googleMfa={one("mfa") === "google"} />;
}
