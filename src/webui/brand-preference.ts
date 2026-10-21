export type BrandChoice = "color" | "blue";
export const BRAND_KEY = "mh-brand";
export type BrandTone = "light" | "dark";
export const BRAND_TONE_KEY = "mh-brand-tone";
let volatileTone: BrandTone = "light";
export function getBrandTone(): BrandTone {
  try { return localStorage.getItem(BRAND_TONE_KEY) === "dark" ? "dark" : "light"; }
  catch { return volatileTone; }
}
export function setBrandTone(tone: BrandTone): void {
  volatileTone = tone;
  try { localStorage.setItem(BRAND_TONE_KEY, tone); } catch { /* Session-only fallback. */ }
  window.dispatchEvent(new Event(EVENT));
}
const EVENT = "mh-brand-change";
let volatileChoice: BrandChoice = "color";
export function getBrand(): BrandChoice {
  try { return localStorage.getItem(BRAND_KEY) === "blue" ? "blue" : "color"; }
  catch { return volatileChoice; }
}
export function setBrand(choice: BrandChoice): void {
  volatileChoice = choice;
  try { localStorage.setItem(BRAND_KEY, choice); } catch { /* Session-only when storage is unavailable. */ }
  window.dispatchEvent(new Event(EVENT));
}
export function subscribeBrand(listener: () => void): () => void {
  const onStorage = (e: StorageEvent) => { if (e.key === BRAND_KEY || e.key === BRAND_TONE_KEY || e.key === null) listener(); };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
