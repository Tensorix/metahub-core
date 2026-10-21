/** @jsxImportSource preact */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import { BRAND_KEY, getBrand, setBrand, subscribeBrand } from "./brand-preference.ts";
import { BrandMark, brandImage, syncBrandFavicon } from "./brand.tsx";
GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => { localStorage.clear(); document.body.innerHTML = ""; document.head.innerHTML = '<link rel="icon">'; });

test("new and invalid preferences use color; blue survives remount and returns to color", () => {
  expect(getBrand()).toBe("color");
  localStorage.setItem(BRAND_KEY, "obsolete");
  expect(getBrand()).toBe("color");
  const host = document.createElement("div");
  document.body.append(host);
  act(() => render(<BrandMark />, host));
  expect(host.querySelector("img")!.src).toBe(brandImage("color"));
  act(() => setBrand("blue"));
  expect(localStorage.getItem(BRAND_KEY)).toBe("blue");
  expect(host.querySelector("img")!.src).toBe(brandImage("blue"));
  act(() => render(null, host));
  act(() => render(<BrandMark />, host));
  expect(host.querySelector("img")!.src).toBe(brandImage("blue"));
  act(() => setBrand("color"));
  expect(host.querySelector("img")!.src).toBe(brandImage("color"));
  act(() => render(null, host));
});

test("storage changes synchronize subscribers and favicon, with cleanup", () => {
  let count = 0;
  const unsubscribe = subscribeBrand(() => { count++; syncBrandFavicon(); });
  localStorage.setItem(BRAND_KEY, "blue");
  window.dispatchEvent(new StorageEvent("storage", { key: BRAND_KEY }));
  expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href).toBe(brandImage("blue", 32));
  window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
  expect(count).toBe(1);
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href).toBe(brandImage("color", 32));
  unsubscribe();
  setBrand("blue");
  expect(count).toBe(2);
});

test("logo background is independent, persistent and updates mounted images and favicon", async () => {
  const { getBrandTone, setBrandTone, BRAND_TONE_KEY } = await import("./brand-preference.ts");
  expect(getBrandTone()).toBe("light");
  const host = document.createElement("div");
  document.body.append(host);
  act(() => render(<BrandMark />, host));
  const unsubscribe = subscribeBrand(syncBrandFavicon);
  act(() => setBrandTone("dark"));
  expect(getBrand()).toBe("color");
  expect(getBrandTone()).toBe("dark");
  expect(localStorage.getItem(BRAND_TONE_KEY)).toBe("dark");
  expect(host.querySelector("img")!.src).toBe(brandImage("color", 192, "dark"));
  expect(host.querySelector("img")!.src).not.toBe(brandImage("color", 192, "light"));
  act(() => setBrand("blue"));
  expect(getBrandTone()).toBe("dark");
  expect(host.querySelector("img")!.src).toBe(brandImage("blue", 192, "dark"));
  expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href).toBe(brandImage("blue", 32, "dark"));
  act(() => render(null, host));
  act(() => render(<BrandMark />, host));
  expect(host.querySelector("img")!.src).toBe(brandImage("blue", 192, "dark"));
  localStorage.setItem(BRAND_TONE_KEY, "light");
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: BRAND_TONE_KEY })));
  expect(host.querySelector("img")!.src).toBe(brandImage("blue", 192, "light"));
  act(() => render(null, host));
  unsubscribe();
});
