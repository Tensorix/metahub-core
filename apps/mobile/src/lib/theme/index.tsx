import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Appearance, useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";

import { dark, light, type Tokens } from "./tokens";

export type ThemePref = "system" | "light" | "dark";

const PREF_KEY = "mh.theme";

interface ThemeCtx {
  tokens: Tokens;
  scheme: "light" | "dark";
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(
    () => (SecureStore.getItem(PREF_KEY) as ThemePref | null) ?? "system",
  );
  const system = useColorScheme();

  // Appearance.setColorScheme drives *native* appearance (SwiftUI/Compose
  // islands, native headers/tab bar, WebView prefers-color-scheme), which is
  // how the RN and native worlds stay on one theme. "system" = null resets.
  useEffect(() => {
    Appearance.setColorScheme(pref === "system" ? "unspecified" : pref);
  }, [pref]);

  const scheme: "light" | "dark" =
    pref === "system" ? (system === "dark" ? "dark" : "light") : pref;

  const value = useMemo<ThemeCtx>(
    () => ({
      tokens: scheme === "dark" ? dark : light,
      scheme,
      pref,
      setPref: (p) => {
        setPrefState(p);
        SecureStore.setItem(PREF_KEY, p);
      },
    }),
    [scheme, pref],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme outside ThemeProvider");
  return v;
}
