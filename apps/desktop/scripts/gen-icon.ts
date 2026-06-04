/**
 * Generate a 1024x1024 placeholder app icon (build/icon.png) with no external
 * dependencies — a pure-TS RGBA rasterizer + PNG encoder (node:zlib for the
 * IDAT deflate). Draws a rounded-square brand gradient with a white "M".
 *
 * electron-builder derives macOS .icns / Windows .ico / Linux .png from this
 * single source image, so one PNG is all that's needed. Swap in a real logo by
 * replacing build/icon.png (>=512x512).
 */
import { deflateSync } from "node:zlib";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const SS = 2; // 2x2 supersampling for smooth edges

// ---- geometry helpers ------------------------------------------------------

/** Distance from point P to segment AB. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Whether P is inside a rounded rectangle. */
function inRoundRect(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
): boolean {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  return Math.hypot(px - cx, py - cy) <= r;
}

// ---- "M" glyph (four thick strokes) ----------------------------------------

const m0 = SIZE * 0.3; // glyph box left/top
const m1 = SIZE * 0.7; // glyph box right/bottom
const mid = (m0 + m1) / 2;
const valley = m0 + (m1 - m0) * 0.62; // where the diagonals meet
const stroke = (m1 - m0) * 0.17;
const hw = stroke / 2;

function inGlyph(px: number, py: number): boolean {
  return (
    segDist(px, py, m0, m1, m0, m0) <= hw || // left vertical
    segDist(px, py, m1, m1, m1, m0) <= hw || // right vertical
    segDist(px, py, m0, m0, mid, valley) <= hw || // left diagonal
    segDist(px, py, m1, m0, mid, valley) <= hw // right diagonal
  );
}

// ---- gradient (top -> bottom) ----------------------------------------------

const TOP = [124, 108, 245] as const; // #7C6CF5
const BOT = [91, 69, 224] as const; // #5B45E0

function gradient(y: number): [number, number, number] {
  const t = y / SIZE;
  return [
    Math.round(TOP[0] + (BOT[0] - TOP[0]) * t),
    Math.round(TOP[1] + (BOT[1] - TOP[1]) * t),
    Math.round(TOP[2] + (BOT[2] - TOP[2]) * t),
  ];
}

// ---- rasterize -------------------------------------------------------------

const sq0 = SIZE * 0.08;
const sq1 = SIZE * 0.92;
const radius = SIZE * 0.2;

const pixels = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let cover = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (!inRoundRect(px, py, sq0, sq0, sq1, sq1, radius)) continue;
        cover++;
        if (inGlyph(px, py)) {
          r += 255;
          g += 255;
          b += 255;
        } else {
          const [gr, gg, gb] = gradient(py);
          r += gr;
          g += gg;
          b += gb;
        }
      }
    }
    const idx = (y * SIZE + x) * 4;
    const samples = SS * SS;
    if (cover > 0) {
      pixels[idx] = Math.round(r / cover);
      pixels[idx + 1] = Math.round(g / cover);
      pixels[idx + 2] = Math.round(b / cover);
      pixels[idx + 3] = Math.round((cover / samples) * 255);
    }
  }
}

// ---- PNG encode ------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!)! & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

// raw scanlines, filter byte 0 per row
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  pixels.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
await mkdir(outDir, { recursive: true });
const outPath = join(outDir, "icon.png");
await Bun.write(outPath, png);

console.log(`✅ Wrote ${outPath} (${SIZE}x${SIZE}, ${png.length} bytes)`);
