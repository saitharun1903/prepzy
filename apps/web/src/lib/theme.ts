"use client";

export type ThemePref = "system" | "light" | "dark";

export function getThemePref(): ThemePref {
  if (typeof document === "undefined") return "system";
  const p = document.documentElement.getAttribute("data-theme-pref");
  return p === "light" || p === "dark" ? p : "system";
}

/** Persist in localStorage AND a cookie (so the server can render the right theme), then apply. */
export function setThemePref(p: ThemePref) {
  try {
    localStorage.setItem("el-theme", p);
  } catch {
    /* storage unavailable */
  }
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `el_theme=${p}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  const w = window as unknown as { __elSetTheme?: (p: string) => void };
  if (w.__elSetTheme) w.__elSetTheme(p);
  else document.documentElement.setAttribute("data-theme", p === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : p);
}
