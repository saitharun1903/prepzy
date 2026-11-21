// Regenerates infrastructure/render/latex-smoke/*.tex from the web app's template engine, so the image build
// compiles exactly the LaTeX users get. CI fails if the committed files are out of date.
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "latex-smoke-"));
const out = join(tmp, "rt.mjs");
await build({ entryPoints: [join(root, "apps/web/src/lib/resume-templates.ts")], bundle: true, format: "esm", outfile: out, logLevel: "warning" });
const { toLatex, SAMPLE_RESUME, LATEX_TEMPLATE_LIST } = await import(pathToFileURL(out).href);
const dir = join(root, "infrastructure/render/latex-smoke");
for (const f of readdirSync(dir)) if (f.endsWith(".tex")) rmSync(join(dir, f));
for (const t of LATEX_TEMPLATE_LIST) writeFileSync(join(dir, `${t.id}.tex`), toLatex(SAMPLE_RESUME, t.id));
// The "fit to page" layout (11pt, spacing stretched to fill the page) must compile too.
writeFileSync(join(dir, "zz-fill-classic.tex"), toLatex(SAMPLE_RESUME, "classic", { size: "11pt", fill: true }));
writeFileSync(join(dir, "zz-fill-tech.tex"), toLatex(SAMPLE_RESUME, "tech", { size: "10pt", fill: true }));
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${LATEX_TEMPLATE_LIST.length} templates + 2 fill layouts`);
