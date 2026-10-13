import type { Metadata, Viewport } from "next";
import { Inter_Tight, Newsreader } from "next/font/google";
import { cookies, headers } from "next/headers";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

const sans = Inter_Tight({ subsets: ["latin"], variable: "--font-inter-tight", display: "swap" });
const serif = Newsreader({ subsets: ["latin"], variable: "--font-newsreader", display: "swap", style: ["normal", "italic"] });

export const metadata: Metadata = {
  title: { default: "Elevate", template: "%s · Elevate" },
  description: "Evidence-based career preparation. Runs locally.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f6f3" },
    { media: "(prefers-color-scheme: dark)", color: "#121311" },
  ],
};

// Runs before first paint: apply the saved theme (localStorage, then cookie) or follow the system.
const THEME_SCRIPT = `(function(){try{var d=document.documentElement,k='el-theme',p=null;try{p=localStorage.getItem(k)}catch(e){}
if(!p){var m=document.cookie.match(/(?:^|; )el_theme=([^;]+)/);p=m?decodeURIComponent(m[1]):'system'}
var mq=window.matchMedia('(prefers-color-scheme: dark)');function a(){var t=p==='light'||p==='dark'?p:(mq.matches?'dark':'light');d.setAttribute('data-theme',t);d.setAttribute('data-theme-pref',p)}
a();mq.addEventListener&&mq.addEventListener('change',function(){if(p==='system'||!p)a()});window.__elSetTheme=function(n){p=n;a()}}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const pref = (await cookies()).get("el_theme")?.value;
  const initial = pref === "light" || pref === "dark" ? pref : undefined;
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`} data-theme={initial} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
