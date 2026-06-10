// Appearance theme: light / dark / system-follow. The choice is *resolved*
// (system → the OS preference) onto <html data-resolved="light|dark"> and
// re-themes the whole UI instantly via the CSS variable overrides in
// src/webui/styles.css — which therefore carries a single dark palette block,
// no prefers-color-scheme duplicate. An inline script in the HTML shell does
// the same resolution before first paint (FOUC guard); this module keeps it in
// sync on change, and app.tsx re-runs it when the OS flips while on "system".

export type ThemeChoice = "light" | "dark" | "system";

const KEY = "mh-theme";

export function getTheme(): ThemeChoice {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

/** Re-resolve choice + OS preference into <html data-resolved>. */
export function syncResolvedTheme(): void {
  const t = getTheme();
  const dark =
    t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.resolved = dark ? "dark" : "light";
}

export function setTheme(t: ThemeChoice): void {
  localStorage.setItem(KEY, t);
  syncResolvedTheme();
  syncThemeColor();
}

// Mobile browser chrome (the status/address bar) tints itself to the page's
// <meta name="theme-color">. Keep it matching the surface actually filling the
// top of the screen so the notch area blends in: on the mobile home that's the
// full-page sidebar (--sidebar); content views and desktop use the page bg.
// Read the resolved *token* (a hex literal in styles.css) rather than an
// element's computed backgroundColor: some mobile browsers ignore theme-color
// updates in rgb() form, and the token already tracks the active theme —
// including a manual light/dark/system toggle, which prefers-color-scheme
// media alone would miss.
export function syncThemeColor(): void {
  const meta = document.getElementById("theme-color-meta");
  if (!meta) return;
  const onHome =
    document.body.classList.contains("mobile") &&
    !document.body.classList.contains("mobile-content");
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue(onHome ? "--sidebar" : "--bg")
    .trim();
  if (color) meta.setAttribute("content", color);
}
