import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";

import { SessionProvider, useSessionCtx } from "@/lib/auth/session";
import { ThemeProvider, useTheme } from "@/lib/theme";

SplashScreen.preventAutoHideAsync();

function RootStack() {
  const { ready, session } = useSessionCtx();
  const { tokens } = useTheme();

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: tokens.bg },
      }}
    >
      <Stack.Protected guard={session !== null}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="db/[id]"
          options={{ headerShown: true, headerBackButtonDisplayMode: "minimal" }}
        />
        <Stack.Screen
          name="record/[id]"
          options={{ presentation: "modal", headerShown: true }}
        />
        <Stack.Screen name="doc/[id]" options={{ headerShown: true }} />
      </Stack.Protected>
      <Stack.Protected guard={session === null}>
        <Stack.Screen name="onboarding/index" />
        <Stack.Screen
          name="onboarding/scan"
          options={{ presentation: "modal", headerShown: true, title: "扫码连接" }}
        />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <SessionProvider>
        <RootStack />
      </SessionProvider>
    </ThemeProvider>
  );
}
