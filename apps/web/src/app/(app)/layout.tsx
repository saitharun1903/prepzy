import { AppShell } from "@/components/shell/app-shell";

// Private, per-user pages: never statically rendered or cached.
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
