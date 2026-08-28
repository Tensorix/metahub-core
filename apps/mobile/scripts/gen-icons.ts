/**
 * Generate the app's icon set from the same pure-TS rasterizer the desktop
 * uses (apps/desktop/scripts/gen-icon.ts) — rounded-square brand gradient
 * with a white "M". Run: bun scripts/gen-icons.ts
 *
 * Outputs (assets/images/):
 *   icon.png                     1024  full mark (iOS + universal)
 *   android-icon-foreground.png  1024  white M on transparent (adaptive fg)
 *   android-icon-background.png  1024  edge-to-edge gradient (adaptive bg)
 *   android-icon-monochrome.png  1024  white M on transparent (themed icon)
 *   splash-icon.png               512  white M on transparent
 *   favicon.png                    48  full mark
 */
import { deflateSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "images");

const TOP = [124, 108, 245] as const; // #7C6CF5
const BOT = [91, 69, 224] as const; // #5B45E0

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inRoundRect(px: number, py: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  return Math.hypot(px - cx, py - cy) <= r;
}

type Mode = "full" | "glyph" | "gradient";

/** Render one PNG. `glyphScale` sets the M's box as a fraction of the size
 *  (adaptive foregrounds keep it inside the 66% safe zone). */
function render(size: number, mode: Mode, glyphScale = 0.4): Buffer {
  const SS = 2;
  const m0 = size * (0.5 - glyphScale / 2);
  const m1 = size * (0.5 + glyphScale / 2);
  const mid = (m0 + m1) / 2;
  const valley = m0 + (m1 - m0) * 0.62;
  const hw = ((m1 - m0) * 0.17) / 2;
  const inGlyph = (px: number, py: number): boolean =>
    segDist(px, py, m0, m1, m0, m0) <= hw ||
    segDist(px, py, m1, m1, m1, m0) <= hw ||
    segDist(px, py, m0, m0, mid, valley) <= hw ||
    segDist(px, py, m1, m0, mid, valley) <= hw;

  const sq0 = size * 0.08;
  const sq1 = size * 0.92;
  const radius = size * 0.2;
  const gradient = (y: number): [number, number, number] => {
    const t = y / size;
    return [
      Math.round(TOP[0] + (BOT[0] - TOP[0]) * t),
      Math.round(TOP[1] + (BOT[1] - TOP[1]) * t),
      Math.round(TOP[2] + (BOT[2] - TOP[2]) * t),
    ];
  };

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (mode === "glyph") {
            if (!inGlyph(px, py)) continue;
            cover++;
            r += 255; g += 255; b += 255;
          } else if (mode === "gradient") {
            cover++;
            const [gr, gg, gb] = gradient(py);
            r += gr; g += gg; b += gb;
          } else {
            if (!inRoundRect(px, py, sq0, sq0, sq1, sq1, radius)) continue;
            cover++;
            if (inGlyph(px, py)) {
              r += 255; g += 255; b += 255;
            } else {
              const [gr, gg, gb] = gradient(py);
              r += gr; g += gg; b += gb;
            }
          }
        }
      }
      const idx = (y * size + x) * 4;
      if (cover > 0) {
        pixels[idx] = Math.round(r / cover);
        pixels[idx + 1] = Math.round(g / cover);
        pixels[idx + 2] = Math.round(b / cover);
        pixels[idx + 3] = Math.round((cover / (SS * SS)) * 255);
      }
    }
  }
  return encodePng(size, pixels);
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size: number, pixels: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outputs: [string, Buffer][] = [
  ["icon.png", render(1024, "full")],
  ["android-icon-foreground.png", render(1024, "glyph", 0.38)],
  ["android-icon-background.png", render(1024, "gradient")],
  ["android-icon-monochrome.png", render(1024, "glyph", 0.38)],
  ["splash-icon.png", render(512, "glyph", 0.6)],
  ["favicon.png", render(48, "full")],
];

for (const [name, buf] of outputs) {
  await Bun.write(join(OUT, name), buf);
  console.log(`wrote ${name} (${buf.length} bytes)`);
}
