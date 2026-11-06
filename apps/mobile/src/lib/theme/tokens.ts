// iOS and the shared fallback use the same palette as desktop/WebUI.
// Android maps these roles to Material 3 in material.android.ts.
import { DARK_THEME, LIGHT_THEME } from "../../../../../src/core/ui-theme";

export interface Tokens {
  bg: string;
  surface: string;
  surface2: string;
  sidebar: string;
  fg: string;
  fgSoft: string;
  muted: string;
  line: string;
  lineStrong: string;
  accent: string;
  accentFg: string;
  accentSoft: string;
  danger: string;
  dangerSoft: string;
  success: string;
  hover: string;
  codeBg: string;
}

/** Map the shared desktop/WebUI palette to native camelCase token names. */
function nativeTokens(palette: Record<keyof typeof LIGHT_THEME, string>): Tokens {
  return {
    bg: palette.bg,
    surface: palette.surface,
    surface2: palette["surface-2"],
    sidebar: palette.sidebar,
    fg: palette.fg,
    fgSoft: palette["fg-soft"],
    muted: palette.muted,
    line: palette.line,
    lineStrong: palette["line-strong"],
    accent: palette.accent,
    accentFg: palette["accent-fg"],
    accentSoft: palette["accent-soft"],
    danger: palette.danger,
    dangerSoft: palette["danger-soft"],
    success: palette.success,
    hover: palette.hover,
    codeBg: palette["code-bg"],
  };
}

export const light: Tokens = nativeTokens(LIGHT_THEME);
export const dark: Tokens = nativeTokens(DARK_THEME);

export const radii = { sm: 6, md: 8, lg: 14, xl: 16 } as const;

/** Font sizes: WebUI's mobile block bumps body to 15–16px; adopt that here. */
export const fs = { body: 16, ui: 15, sm: 13, xs: 12 } as const;
