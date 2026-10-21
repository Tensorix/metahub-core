/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import { getBrand, getBrandTone, subscribeBrand, type BrandChoice, type BrandTone } from "./brand-preference.ts";
import { BRAND_IMAGES, BRAND_FRAMES } from "./brand-images.ts";
export function brandImage(choice: BrandChoice, size: 192 | 32 = 192, tone: BrandTone = getBrandTone()): string {
  return "data:image/png;base64," + BRAND_IMAGES[choice][tone][size];
}
export function useBrandTone(): BrandTone {
  const [tone, setTone] = useState(getBrandTone);
  useEffect(() => {
    const update = () => setTone(getBrandTone());
    const unsubscribe = subscribeBrand(update);
    update();
    return unsubscribe;
  }, []);
  return tone;
}
export function useBrand(): BrandChoice {
  const [choice, setChoice] = useState(getBrand);
  useEffect(() => {
    const update = () => setChoice(getBrand());
    const unsubscribe = subscribeBrand(update);
    update();
    return unsubscribe;
  }, []);
  return choice;
}
export function BrandMark({ variant, tone }: { variant?: BrandChoice; tone?: BrandTone }) {
  const currentTone = useBrandTone();
  const choice = useBrand();
  const frame = BRAND_FRAMES[variant ?? choice][tone ?? currentTone];
  // Normalize the visible tile, not the transparent PNG canvas. A small inset
  // retains antialiased edges while keeping every variant optically aligned.
  return <span class="brand-icon" aria-hidden="true">
    <img src={brandImage(variant ?? choice, 192, tone ?? currentTone)} alt=""
      width={192} height={192} style={{
        width: (frame.canvas / frame.size * 100) + "%",
        height: (frame.canvas / frame.size * 100) + "%",
        left: (-frame.x / frame.size * 100) + "%",
        top: (-frame.y / frame.size * 100) + "%",
      }} />
  </span>;
}
export function syncBrandFavicon(): void {
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon) icon.href = brandImage(getBrand(), 32);
}
