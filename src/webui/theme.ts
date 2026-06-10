// Appearance theme: light / dark / system-follow. The choice is mirrored onto
// <html data-theme="..."> and re-themes the whole UI instantly via the CSS
// variable overrides in src/webui/styles.css — no React re-render needed. An
// inline script in the HTML shell applies the stored value before first paint
// (FOUC guard); this module keeps it in sync on change.

export type ThemeChoice = "light" | "dark" | "system";

const KEY = "mh-theme";

export function getTheme(): ThemeChoice {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export function setTheme(t: ThemeChoice): void {
  localStorage.setItem(KEY, t);
  document.documentElement.dataset.theme = t;
  syncThemeColor();
}

// Mobile browser chrome (the status/address bar) tints itself to the page's
// <meta name="theme-color">. Keep it matching the surface actually filling the
// top of the screen so the notch area blends in: on the mobile home that's the
// full-page sidebar (--sidebar); content views and desktop use the page bg.
// Read the resolved color so it tracks the active theme — including a manual
// light/dark/system toggle, which prefers-color-scheme media alone would miss.
export function syncThemeColor(): void {
  const meta = document.getElementById("theme-color-meta");
  if (!meta) return;
  const onHome =
    document.body.classList.contains("mobile") &&
    !document.body.classList.contains("mobile-content");
  const el = (onHome && document.querySelector(".sidebar")) || document.body;
  meta.setAttribute("content", getComputedStyle(el as HTMLElement).backgroundColor);
}
