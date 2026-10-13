// Tiny PNG encoder + programmatic monogram icon (no image dependencies).
import { crc32, deflateSync } from "node:zlib";

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** Encode RGBA pixels (Uint8Array, width*height*4) as PNG. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Draw the Elevate monogram: a rounded square in the accent colour with a geometric "E".
 * Supersampled 4x for smooth edges.
 */
export function monogramIcon(size) {
  const SS = 4;
  const N = size * SS;
  const bg = [0x2b, 0x5a, 0x4a];
  const fg = [0xff, 0xff, 0xff];
  const radius = N * 0.22;
  const inRoundedSquare = (x, y) => {
    const cx = Math.min(Math.max(x, radius), N - radius);
    const cy = Math.min(Math.max(y, radius), N - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  // "E" geometry in unit coordinates.
  const left = 0.3, right = 0.7, midRight = 0.64, top = 0.24, bottom = 0.76, stroke = 0.115;
  const bars = [
    [left, top, right, top + stroke],
    [left, 0.5 - stroke / 2, midRight, 0.5 + stroke / 2],
    [left, bottom - stroke, right, bottom],
    [left, top, left + stroke, bottom],
  ];
  const inE = (u, v) => bars.some(([x0, y0, x1, y1]) => u >= x0 && u <= x1 && v >= y0 && v <= y1);
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let cover = 0;
      let ink = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px * SS + sx + 0.5;
          const y = py * SS + sy + 0.5;
          if (!inRoundedSquare(x, y)) continue;
          cover++;
          if (inE(x / N, y / N)) ink++;
        }
      }
      const i = (py * size + px) * 4;
      const a = cover / (SS * SS);
      const t = cover ? ink / cover : 0;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(bg[c] * (1 - t) + fg[c] * t);
      out[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, out);
}
