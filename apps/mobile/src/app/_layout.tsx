import { NativeDiagnostics } from "@/lib/diagnostics/NativeDiagnostics";
import { Stack, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useRef } from "react";

import { SessionProvider, useSessionCtx } from "@/lib/auth/session";
import { ThemeProvider, useTheme } from "@/lib/theme";

SplashScreen.preventAutoHideAsync();

function RootStack() {
  const { ready, session } = useSessionCtx();
  const { tokens } = useTheme();
  const router = useRouter();
  const sessionId = session?.id ?? null;
  const lastSessionId = useRef<number | null>(null);
  useEffect(() => {
    if (!ready) return;
    const previous = lastSessionId.current;
    lastSessionId.current = sessionId;
    if (sessionId !== null && previous !== null && previous !== sessionId) {
      router.replace("/(tabs)");
    }
  }, [ready, sessionId, router]);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <Stack
      key={session?.id ?? "signed-out"}
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: tokens.bg },
      }}
    >
      <Stack.Protected guard={session !== null}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="db/[id]"
          options={{
            headerShown: true,
            headerBackButtonDisplayMode: "minimal",
          }}
        />
        <Stack.Screen
          name="record/[id]"
          options={{ presentation: "modal", headerShown: true }}
        />
        <Stack.Screen name="doc/[id]" options={{ headerShown: true }} />
        <Stack.Screen
          name="add-server"
          options={{ presentation: "modal", headerShown: true }}
        />
      </Stack.Protected>
      <Stack.Protected guard={session === null}>
        <Stack.Screen name="onboarding/index" />
        <Stack.Screen
          name="onboarding/scan"
          options={{
            presentation: "modal",
            headerShown: true,
            title: "扫码连接",
          }}
        />
      </Stack.Protected>
      <Stack.Screen name="connect" options={{ headerShown: true, title: "连接存储桶" }} />
    </Stack>
  );
}

export default function RootLayout() {
  if (__DEV__ && process.env.EXPO_PUBLIC_MH_SELFTEST === "1") {
    void SplashScreen.hideAsync();
    return <NativeDiagnostics />;
  }
  return (
    <ThemeProvider>
      <SessionProvider>
        <RootStack />
      </SessionProvider>
    </ThemeProvider>
  );
}
