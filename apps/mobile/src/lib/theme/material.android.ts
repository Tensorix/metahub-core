// Android: Material 3 palette as the app's token source. Default is a
// brand-seeded palette (SchemeTonalSpot from metahub indigo — consistent on
// every device and API level); the Material You toggle switches to the
// wallpaper-derived palette on Android 12+.
import {
  isDynamicColorAvailable,
  useMaterialColors,
} from "@expo/ui/jetpack-compose";

import { light, type Tokens } from "./tokens";

const SEED = light.accent; // #4a55d6 — the metahub brand indigo

export const dynamicColorAvailable = isDynamicColorAvailable;

export function useMaterialTokens(
  scheme: "light" | "dark",
  materialYou: boolean,
): Tokens | null {
  const m = useMaterialColors({
    colorScheme: scheme,
    // Omitting seedColor = wallpaper palette (Android 12+) / M3 baseline.
    ...(materialYou && isDynamicColorAvailable ? {} : { seedColor: SEED }),
  });
  return {
    bg: m.background,
    surface: m.surfaceContainerLow,
    surface2: m.surfaceContainerHigh,
    sidebar: m.surfaceContainer,
    fg: m.onBackground,
    fgSoft: m.onSurfaceVariant,
    muted: m.outline,
    line: m.outlineVariant,
    lineStrong: m.outline,
    accent: m.primary,
    accentFg: m.onPrimary,
    accentSoft: m.primaryContainer,
    danger: m.error,
    dangerSoft: m.errorContainer,
    success: scheme === "dark" ? "#3fb950" : "#1f8f3e", // M3 has no success role
    hover: `${m.onSurface.slice(0, 7)}14`, // onSurface @ 8%
    codeBg: m.surfaceContainerHigh,
  };
}
