// Appearance theme: light / dark / system-follow. The choice is mirrored onto
// <html data-theme="..."> and re-themes the whole UI instantly via the CSS
// variable overrides in core/sync/webui.ts — no React re-render needed. An
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
}
