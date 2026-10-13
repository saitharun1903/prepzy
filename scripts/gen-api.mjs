// Generates packages/api-client/src/schema.ts from the implemented FastAPI OpenAPI document.
// Usage: npm run gen:api   (API must be running, or pass a file path: node scripts/gen-api.mjs openapi.json)
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const src = process.argv[2] ?? "http://127.0.0.1:8000/api/v1/openapi.json";
let input = src;
if (src.startsWith("http")) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`OpenAPI fetch failed: ${res.status}`);
  writeFileSync("packages/api-client/openapi.json", JSON.stringify(await res.json(), null, 1));
  input = "packages/api-client/openapi.json";
}
execFileSync(process.execPath, ["node_modules/openapi-typescript/bin/cli.js", input, "-o", "packages/api-client/src/schema.ts"], { stdio: "inherit" });
