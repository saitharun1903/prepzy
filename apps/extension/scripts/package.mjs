// Zip dist-release/ into release/elevate-extension-<version>.zip (store upload format).
// Self-contained ZIP writer (deflate via node:zlib) so it works the same on Windows, macOS and Linux.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(ROOT, "dist-release");
if (!existsSync(join(src, "manifest.json"))) {
  console.error("FAIL: dist-release/ is missing. Run `npm run build:release` first.");
  process.exit(1);
}
// Refuse to package anything that fails release validation (e.g. a manifest "key" or key material).
execFileSync(process.execPath, [join(ROOT, "scripts/validate.mjs"), "dist-release", "--release"], { stdio: "inherit" });

const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`FAIL: manifest version ${manifest.version} != package.json version ${pkg.version}. Rebuild.`);
  process.exit(1);
}

function walk(d) {
  return readdirSync(d)
    .sort()
    .flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const entries = [];
const chunks = [];
let offset = 0;
const { time, day } = dosDateTime(new Date());
for (const file of walk(src)) {
  const name = relative(src, file).replaceAll("\\", "/");
  const data = readFileSync(file);
  const comp = deflateRawSync(data, { level: 9 });
  const useDeflate = comp.length < data.length;
  const body = useDeflate ? comp : data;
  const crc = crc32(data) >>> 0;
  const nameBuf = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(useDeflate ? 8 : 0, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuf, body);
  entries.push({ nameBuf, crc, csize: body.length, usize: data.length, method: useDeflate ? 8 : 0, offset });
  offset += local.length + nameBuf.length + body.length;
}
const cdStart = offset;
for (const e of entries) {
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0);
  c.writeUInt16LE(20, 4);
  c.writeUInt16LE(20, 6);
  c.writeUInt16LE(0x0800, 8);
  c.writeUInt16LE(e.method, 10);
  c.writeUInt16LE(time, 12);
  c.writeUInt16LE(day, 14);
  c.writeUInt32LE(e.crc, 16);
  c.writeUInt32LE(e.csize, 20);
  c.writeUInt32LE(e.usize, 24);
  c.writeUInt16LE(e.nameBuf.length, 28);
  c.writeUInt32LE(0, 38);
  c.writeUInt32LE(e.offset, 42);
  chunks.push(c, e.nameBuf);
  offset += c.length + e.nameBuf.length;
}
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(offset - cdStart, 12);
end.writeUInt32LE(cdStart, 16);
chunks.push(end);
const zip = Buffer.concat(chunks);

// Self-check: re-read every entry from the central directory and verify its CRC.
{
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const nlen = zip.readUInt16LE(p + 28);
    const lo = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = zip.readUInt16LE(lo + 26);
    const lextra = zip.readUInt16LE(lo + 28);
    const body = zip.subarray(lo + 30 + lnlen + lextra, lo + 30 + lnlen + lextra + csize);
    const data = method === 8 ? inflateRawSync(body) : body;
    if ((crc32(data) >>> 0) !== crc) throw new Error(`zip self-check failed for ${name}`);
    p += 46 + nlen;
  }
}

const outDir = join(ROOT, "release");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `elevate-extension-${pkg.version}.zip`);
writeFileSync(out, zip);
console.log(`Packaged ${entries.length} files -> ${out} (${(zip.length / 1024).toFixed(1)} KiB, verified)`);
