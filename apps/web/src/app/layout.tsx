import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";
import { HOSTED } from "@/lib/hosting";


export const metadata: Metadata = {
  title: { default: "Prepzy", template: "%s · Prepzy" },
  description: HOSTED ? "Evidence-based career preparation." : "Evidence-based career preparation. Runs locally.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f7f8fc",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} data-theme="light">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
