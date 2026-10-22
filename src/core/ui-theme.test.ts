import { expect, test } from "bun:test";
import { LIGHT_THEME, DARK_THEME, THEME_INIT_SCRIPT } from "./ui-theme.ts";

function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
}
function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
for (const [name, p] of Object.entries({ light: LIGHT_THEME, dark: DARK_THEME })) {
  test(`${name}: text, selected labels and primary/error buttons meet AA contrast`, () => {
    for (const surface of [p.bg, p.surface, p.sidebar, p["surface-2"]]) {
      for (const foreground of [p.fg, p["fg-soft"], p.muted]) {
        expect(contrast(foreground, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const [fg, bg] of [
      [p.accent, p["accent-soft"]], [p["accent-fg"], p.accent],
      [p["danger-fg"], p.danger], [p.warning, p.bg], [p.success, p.bg],
    ]) expect(contrast(fg!, bg!)).toBeGreaterThanOrEqual(4.5);
    for (const surface of [p["selected-bg"], p["selected-hover-bg"]]) {
      for (const foreground of [p.fg, p["selected-muted"]]) {
        expect(contrast(foreground, surface)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(p.accent, surface)).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(p["selected-icon-fg"], p["selected-icon-bg"])).toBeGreaterThanOrEqual(3);
  });
}
test("first paint respects explicit preference, system mode and unavailable storage", () => {
  const run = new Function("localStorage", "matchMedia", "document", THEME_INIT_SCRIPT);
  for (const [choice, osDark, expected] of [
    ["light", true, "light"], ["dark", false, "dark"],
    ["system", true, "dark"], [null, false, "light"], ["blocked", true, "dark"],
  ] as const) {
    const meta = { content: "" };
    const doc = { documentElement: { dataset: {} as Record<string, string> }, querySelector: () => meta };
    run({ getItem() { if (choice === "blocked") throw Error("denied"); return choice; } }, () => ({ matches: osDark }), doc);
    expect(doc.documentElement.dataset.resolved).toBe(expected);
    expect(meta.content).toBe(expected === "dark" ? DARK_THEME.bg : LIGHT_THEME.bg);
  }
});
