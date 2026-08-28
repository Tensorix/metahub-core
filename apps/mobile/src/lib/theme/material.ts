// iOS / default stub — the real implementation lives in material.android.ts
// (importing @expo/ui/jetpack-compose on iOS crashes at runtime, so the
// Android-only dependency is isolated behind Metro platform resolution).
import type { Tokens } from "./tokens";

export const dynamicColorAvailable = false;

export function useMaterialTokens(
  _scheme: "light" | "dark",
  _materialYou: boolean,
): Tokens | null {
  return null;
}
