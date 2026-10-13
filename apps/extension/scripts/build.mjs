// Build the extension.
//   node scripts/build.mjs --mode=dev      -> dist/          (manifest "key" pins the dev extension ID)
//   node scripts/build.mjs --mode=release  -> dist-release/  (no "key"; URLs from ELEVATE_EXT_API_URL / ELEVATE_EXT_WEB_URL,
//                                            optional extra connect origins in ELEVATE_EXT_CONNECT_ORIGINS)
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { monogramIcon } from "./png.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = (process.argv.find((a) => a.startsWith("--mode=")) ?? "--mode=dev").slice(7);
if (mode !== "dev" && mode !== "release") throw new Error(`Unknown mode: ${mode}`);

const DEV_API = "http://127.0.0.1:8000";
const DEV_WEB = "http://localhost:3000";

function origin(name, raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${name} must be http(s): ${raw}`);
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash || u.username || u.password) {
    throw new Error(`${name} must be an origin only (no path, query, credentials): ${raw}`);
  }
  return u.origin;
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
let apiBase = DEV_API;
let webBase = DEV_WEB;
if (mode === "release") {
  const envApi = process.env.ELEVATE_EXT_API_URL;
  const envWeb = process.env.ELEVATE_EXT_WEB_URL;
  if (!envApi || !envWeb) {
    console.warn(
      "WARNING: ELEVATE_EXT_API_URL and/or ELEVATE_EXT_WEB_URL are not set; the release build falls back to the\n" +
        `         development URLs (${DEV_API}, ${DEV_WEB}). Set both (https) before store submission.`,
    );
  }
  apiBase = origin("ELEVATE_EXT_API_URL", envApi || DEV_API);
  webBase = origin("ELEVATE_EXT_WEB_URL", envWeb || DEV_WEB);
} else {
  apiBase = origin("api", DEV_API);
  webBase = origin("web", DEV_WEB);
}
// The web app origin may hand a session to the extension. A release build may add more (comma-separated).
const extraConnect = mode === "release" && process.env.ELEVATE_EXT_CONNECT_ORIGINS
  ? process.env.ELEVATE_EXT_CONNECT_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean).map((s) => origin("ELEVATE_EXT_CONNECT_ORIGINS", s))
  : [];
const connectOrigins = [...new Set([webBase, ...extraConnect])];

const outdir = join(ROOT, mode === "dev" ? "dist" : "dist-release");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(join(outdir, "icons"), { recursive: true });

await build({
  entryPoints: { background: join(ROOT, "src/background/sw.ts"), ui: join(ROOT, "src/ui/app.ts") },
  outdir,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  minify: mode === "release",
  keepNames: false, // the injected extraction function must stay free of esbuild helpers
  sourcemap: mode === "dev" ? "linked" : false,
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
  define: {
    __ELEVATE_API_BASE__: JSON.stringify(apiBase),
    __ELEVATE_WEB_BASE__: JSON.stringify(webBase),
    __ELEVATE_CONNECT_ORIGINS__: JSON.stringify(connectOrigins),
    __ELEVATE_BUILD_MODE__: JSON.stringify(mode),
  },
});

for (const f of ["popup.html", "sidepanel.html", "ui.css"]) copyFileSync(join(ROOT, "src/ui", f), join(outdir, f));

const sizes = [16, 32, 48, 128];
for (const s of sizes) writeFileSync(join(outdir, "icons", `icon-${s}.png`), monogramIcon(s));
const icons = Object.fromEntries(sizes.map((s) => [String(s), `icons/icon-${s}.png`]));

const manifest = {
  manifest_version: 3,
  name: "Elevate",
  short_name: "Elevate",
  version: pkg.version,
  description: "Capture a job posting from the current tab and get an evidence-based analysis in your Elevate account.",
  minimum_chrome_version: "120",
  permissions: ["activeTab", "scripting", "storage", "alarms", "sidePanel"],
  host_permissions: [`${apiBase}/*`],
  externally_connectable: { matches: connectOrigins.map((o) => `${o}/*`) },
  action: { default_title: "Elevate", default_popup: "popup.html", default_icon: { 16: icons["16"], 32: icons["32"] } },
  side_panel: { default_path: "sidepanel.html" },
  background: { service_worker: "background.js", type: "module" },
  icons,
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
};
if (mode === "dev") {
  const key = JSON.parse(readFileSync(join(ROOT, "manifest-key.json"), "utf8"));
  if (typeof key.key !== "string" || key.key.length < 100) throw new Error("manifest-key.json has no public key");
  manifest.key = key.key; // public key only — pins the dev extension ID
}
writeFileSync(join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`Built ${mode} extension -> ${outdir}`);
console.log(`  API ${apiBase} | web ${webBase} | connect origins ${connectOrigins.join(", ")}`);
