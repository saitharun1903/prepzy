// Static checks on a built extension directory.
//   node scripts/validate.mjs dist
//   node scripts/validate.mjs dist-release --release [--if-present]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dirArg = args.find((a) => !a.startsWith("--")) ?? "dist";
const release = args.includes("--release");
const ifPresent = args.includes("--if-present");
const dir = resolve(ROOT, dirArg);

if (!existsSync(dir)) {
  if (ifPresent) {
    console.log(`skip: ${dirArg} not built`);
    process.exit(0);
  }
  console.error(`FAIL: ${dirArg} does not exist. Run the build first.`);
  process.exit(1);
}

const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function walk(d) {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(dir);
const rel = (p) => relative(dir, p).replaceAll("\\", "/");

// ---------------------------------------------------------------- manifest
const mpath = join(dir, "manifest.json");
if (!existsSync(mpath)) {
  console.error("FAIL: manifest.json missing");
  process.exit(1);
}
const m = JSON.parse(readFileSync(mpath, "utf8"));
const expectPerms = ["activeTab", "scripting", "storage", "alarms", "sidePanel"];
if (m.manifest_version !== 3) fail("manifest_version must be 3");
if (m.name !== "Elevate") fail('name must be "Elevate"');
if (m.minimum_chrome_version !== "120") fail('minimum_chrome_version must be "120"');
if (!/^\d+(\.\d+){0,3}$/.test(m.version ?? "")) fail("version must be dotted numbers");
const perms = m.permissions ?? [];
if (perms.length !== expectPerms.length || !expectPerms.every((p) => perms.includes(p))) {
  fail(`permissions must be exactly ${JSON.stringify(expectPerms)}; got ${JSON.stringify(perms)}`);
}
if (m.optional_permissions?.length || m.optional_host_permissions?.length) fail("no optional permissions expected");
const hp = m.host_permissions ?? [];
if (hp.length !== 1 || !/^https?:\/\/[a-z0-9.\-[\]:]+\/\*$/i.test(hp[0]) || hp[0].includes("*.")) {
  fail(`host_permissions must be exactly one API origin pattern; got ${JSON.stringify(hp)}`);
}
const apiOrigin = hp[0] ? hp[0].slice(0, -2) : "";
const ec = m.externally_connectable?.matches ?? [];
if (!ec.length || ec.some((p) => !/^https?:\/\/[a-z0-9.\-:]+\/\*$/i.test(p) || p.includes("*."))) {
  fail(`externally_connectable.matches must list explicit http(s) origins; got ${JSON.stringify(ec)}`);
}
if (m.externally_connectable?.ids?.length) fail("externally_connectable.ids must not be set");
const webOrigins = ec.map((p) => p.slice(0, -2));
if (m.content_scripts) fail("content_scripts must not be declared (injection happens on click only)");
if (m.web_accessible_resources) fail("web_accessible_resources must not be declared");
if (m.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'self'") {
  fail("content_security_policy.extension_pages must be \"script-src 'self'; object-src 'self'\"");
}
if (m.background?.service_worker !== "background.js" || m.background?.type !== "module") fail("background must be a module service worker background.js");
if (m.action?.default_popup !== "popup.html") fail("action.default_popup must be popup.html");
if (m.side_panel?.default_path !== "sidepanel.html") fail("side_panel.default_path must be sidepanel.html");
for (const ref of [m.background?.service_worker, m.action?.default_popup, m.side_panel?.default_path, ...Object.values(m.icons ?? {}), ...Object.values(m.action?.default_icon ?? {})]) {
  if (ref && !existsSync(join(dir, ref))) fail(`manifest references missing file: ${ref}`);
}
for (const s of ["16", "48", "128"]) if (!m.icons?.[s]) fail(`icons.${s} missing`);
for (const p of Object.values(m.icons ?? {})) {
  const buf = existsSync(join(dir, p)) ? readFileSync(join(dir, p)) : Buffer.alloc(0);
  if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") fail(`${p} is not a PNG`);
}
if (release) {
  if (m.key) fail("release manifest must not contain \"key\"");
  if (!apiOrigin.startsWith("https://")) warn(`release API origin is not https (${apiOrigin}); set ELEVATE_EXT_API_URL before store submission`);
  for (const o of webOrigins) if (!o.startsWith("https://")) warn(`release connect origin is not https (${o}); set ELEVATE_EXT_WEB_URL before store submission`);
} else {
  const key = JSON.parse(readFileSync(join(ROOT, "manifest-key.json"), "utf8")).key;
  if (m.key !== key) fail("dev manifest must carry the public key from manifest-key.json");
}

// ---------------------------------------------------------------- files
const allowedExt = new Set([".js", ".html", ".css", ".png", ".json", ...(release ? [] : [".map"])]);
for (const f of files) {
  const e = extname(f).toLowerCase();
  if (!allowedExt.has(e)) fail(`unexpected file type in bundle: ${rel(f)}`);
  if (/\.(pem|key|crx)$/i.test(f) || /dev-key/i.test(f)) fail(`private key material must never be bundled: ${rel(f)}`);
}

// ---------------------------------------------------------------- code
const ALLOWED_URL_PREFIXES = [apiOrigin, ...webOrigins, "http://www.w3.org/"];
const urlRe = /\bhttps?:\/\/[^\s"'`)<>\\]+/g;
for (const f of files.filter((p) => /\.(js|html|css)$/.test(p))) {
  const src = readFileSync(f, "utf8");
  const name = rel(f);
  if (/\beval\s*\(/.test(src)) fail(`${name}: contains eval(`);
  if (/\bnew\s+Function\s*\(/.test(src)) fail(`${name}: contains new Function(`);
  if (/<script[^>]+src\s*=\s*["']?(https?:)?\/\//i.test(src)) fail(`${name}: remote <script src>`);
  if (/<link[^>]+href\s*=\s*["']?(https?:)?\/\//i.test(src)) fail(`${name}: remote stylesheet/link`);
  if (/\bimport\s*\(\s*["'`]https?:/.test(src) || /\bimportScripts\s*\(/.test(src)) fail(`${name}: remote code import`);
  if (/@import\s+(url\()?["']?https?:/i.test(src)) fail(`${name}: remote CSS import`);
  if (/\.innerHTML\s*=|insertAdjacentHTML|document\.write\s*\(/.test(src)) fail(`${name}: HTML injection sink (innerHTML/insertAdjacentHTML/document.write)`);
  if (/BEGIN (RSA |EC )?PRIVATE KEY/.test(src)) fail(`${name}: contains a private key`);
  for (const u of src.match(urlRe) ?? []) {
    if (!ALLOWED_URL_PREFIXES.some((p) => p && (u === p || u.startsWith(p.endsWith("/") ? p : `${p}/`)))) {
      fail(`${name}: unexpected remote URL ${u}`);
    }
  }
}

const total = files.reduce((n, f) => n + statSync(f).size, 0);
for (const w of warnings) console.warn(`WARN: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`FAIL: ${e}`);
  console.error(`${errors.length} problem(s) in ${dirArg}`);
  process.exit(1);
}
console.log(`OK: ${dirArg} (${files.length} files, ${(total / 1024).toFixed(1)} KiB) — manifest, permissions, CSP and bundle checks passed`);
