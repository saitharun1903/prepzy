import type { Metadata } from "next";
import { VerifyEmail } from "@/components/auth/recovery-forms";

// The URL carries a one-time token: never leak it through the Referer header.
export const metadata: Metadata = { title: "Confirm email", referrer: "no-referrer" };

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  return <VerifyEmail token={token} />;
}
