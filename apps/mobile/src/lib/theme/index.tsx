import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Appearance, useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";

import { dynamicColorAvailable, useMaterialTokens } from "./material";
import { dark, light, type Tokens } from "./tokens";

export type ThemePref = "system" | "light" | "dark";

const PREF_KEY = "mh.theme";
const MATERIAL_YOU_KEY = "mh.material-you";

interface ThemeCtx {
  tokens: Tokens;
  scheme: "light" | "dark";
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
  /** Android 12+ only: wallpaper-derived palette toggle (Material You). */
  dynamicAvailable: boolean;
  materialYou: boolean;
  setMaterialYou: (on: boolean) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(
    () => (SecureStore.getItem(PREF_KEY) as ThemePref | null) ?? "system",
  );
  const [materialYou, setMaterialYouState] = useState<boolean>(
    () => SecureStore.getItem(MATERIAL_YOU_KEY) === "1",
  );
  const system = useColorScheme();

  // Appearance.setColorScheme drives *native* appearance (SwiftUI/Compose
  // islands, native headers/tab bar, WebView prefers-color-scheme), which is
  // how the RN and native worlds stay on one theme. "unspecified" resets.
  useEffect(() => {
    Appearance.setColorScheme(pref === "system" ? "unspecified" : pref);
  }, [pref]);

  const scheme: "light" | "dark" =
    pref === "system" ? (system === "dark" ? "dark" : "light") : pref;

  // Android: M3 roles (brand-seeded, or wallpaper when Material You is on).
  // iOS (stub returns null): the WebUI's metahub palette.
  const materialTokens = useMaterialTokens(scheme, materialYou);

  const value = useMemo<ThemeCtx>(
    () => ({
      tokens: materialTokens ?? (scheme === "dark" ? dark : light),
      scheme,
      pref,
      setPref: (p) => {
        setPrefState(p);
        SecureStore.setItem(PREF_KEY, p);
      },
      dynamicAvailable: dynamicColorAvailable,
      materialYou,
      setMaterialYou: (on) => {
        setMaterialYouState(on);
        SecureStore.setItem(MATERIAL_YOU_KEY, on ? "1" : "0");
      },
    }),
    [materialTokens, scheme, pref, materialYou],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme outside ThemeProvider");
  return v;
}
