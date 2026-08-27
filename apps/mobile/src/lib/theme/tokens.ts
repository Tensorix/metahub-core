// Metahub design tokens, lifted verbatim from src/webui/styles.css :root
// blocks so the app reads as the same product as the WebUI/desktop.
// Android swaps these for Material 3 roles (see index.tsx) — these hex values
// are the iOS (and shared fallback) palette.

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

export const light: Tokens = {
  bg: "#ffffff",
  surface: "#fbfbfa",
  surface2: "#f1f1ef",
  sidebar: "#f7f7f5",
  fg: "#2c2c30",
  fgSoft: "#5b5b62",
  muted: "#75757f",
  line: "#ebebe8",
  lineStrong: "#dededb",
  accent: "#4a55d6",
  accentFg: "#ffffff",
  accentSoft: "#eef0ff",
  danger: "#d6473b",
  dangerSoft: "#fdeceb",
  success: "#1f8f3e",
  hover: "rgba(45,45,55,0.045)",
  codeBg: "#f8f8f6",
};

export const dark: Tokens = {
  bg: "#1a1a1c",
  surface: "#202022",
  surface2: "#2a2a2d",
  sidebar: "#171719",
  fg: "#e6e6e9",
  fgSoft: "#b4b4bb",
  muted: "#8b8b95",
  line: "#2c2c30",
  lineStrong: "#3a3a40",
  accent: "#7b86ff",
  accentFg: "#14141a",
  accentSoft: "#23243a",
  danger: "#f87168",
  dangerSoft: "#341e1c",
  success: "#3fb950",
  hover: "rgba(255,255,255,0.05)",
  codeBg: "#1d1d20",
};

export const radii = { sm: 6, md: 8, lg: 14, xl: 16 } as const;

/** Font sizes: WebUI's mobile block bumps body to 15–16px; adopt that here. */
export const fs = { body: 16, ui: 15, sm: 13, xs: 12 } as const;
