// Run with Bun to derive mobile resources from the desktop's default color family.
import { join } from "node:path";
import { PNG } from "pngjs";
import Jimp from "jimp-compact";

const brand = join(import.meta.dir, "../../../assets/brand");
const output = join(import.meta.dir, "../assets/images");
const master = await Jimp.read(join(brand, "color/icon-1024.png"));
const frame = (await Bun.file(join(brand, "frames.json")).json()).color.light;
const scale = master.bitmap.width / frame.canvas;
const tileSize = Math.round(frame.size * scale);
const framed = master.clone().crop(
  Math.round(frame.x * scale), Math.round(frame.y * scale), tileSize, tileSize,
).resize(1024, 1024, Jimp.RESIZE_BICUBIC);

// The OS supplies the launcher mask. Fill the transparent corners with the tile color.
const launcher = new Jimp(1024, 1024, 0xf5f7fcff).composite(framed, 0, 0);
await Bun.write(join(output, "icon.png"), PNG.sync.write(launcher.bitmap, { colorType: 2 }));
await framed.writeAsync(join(output, "splash-icon.png"));
await Bun.write(join(output, "favicon.png"), Bun.file(join(brand, "color/icon-32.png")));

// Android masks and animates separate layers. Keep the modules in its 66dp safe circle.
const size = 1080;
const inset = (size - master.bitmap.width) / 2;
const foreground = new Jimp(size, size, 0);
const monochrome = new Jimp(size, size, 0);
master.scan(0, 0, master.bitmap.width, master.bitmap.height, (x: number, y: number, i: number) => {
  const dx = x + inset + 0.5 - size / 2;
  const dy = y + inset + 0.5 - size / 2;
  if (Math.hypot(dx, dy) >= 330) return;
  const [r, g, b, a] = master.bitmap.data.subarray(i, i + 4);
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  const alpha = Math.round(a * Math.min(1, Math.max(0, (chroma - 16) / 48)));
  const dest = ((y + inset) * size + x + inset) * 4;
  foreground.bitmap.data.set([r, g, b, alpha], dest);
  monochrome.bitmap.data.set([255, 255, 255, alpha], dest);
});
await Bun.write(join(output, "android-icon-foreground.png"), PNG.sync.write(foreground.bitmap));
await Bun.write(join(output, "android-icon-monochrome.png"), PNG.sync.write(monochrome.bitmap));
