import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/recovery-forms";

// The URL carries a one-time token: never leak it through the Referer header.
export const metadata: Metadata = { title: "Choose a new password", referrer: "no-referrer" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  return <ResetPasswordForm token={token} />;
}
