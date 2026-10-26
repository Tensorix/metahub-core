import { NativeDiagnostics } from "@/lib/diagnostics/NativeDiagnostics";
import { diagnosticsEnabled } from "@/lib/diagnostics/build-mode";
import { Stack, useNavigationContainerRef } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { SessionProvider, useSessionCtx } from "@/lib/auth/session";
import { ThemeProvider, useTheme } from "@/lib/theme";
import {
  findWorkspaceStack,
  shouldResetSessionNavigation,
  type SessionIdentity,
} from "@/lib/auth/session-lifecycle";

SplashScreen.preventAutoHideAsync();

/** A route from another workspace must unmount before its history is reset. */
function WorkspaceScreen({ workspaceId, children }: {
  workspaceId: string | undefined;
  children: ReactNode;
}) {
  const [owner] = useState(workspaceId);
  return owner === workspaceId ? children : null;
}

function RootStack() {
  const { ready, session } = useSessionCtx();
  const { tokens } = useTheme();
  const navigation = useNavigationContainerRef();
  const previousSession = useRef<SessionIdentity | null | undefined>(undefined);
  const sessionId = session?.id;
  const workspaceId = session?.workspaceId;
  useEffect(() => {
    const updateNavigation = () => {
      if (!ready || !navigation.isReady()) return;
      const next = sessionId !== undefined && workspaceId !== undefined
        ? { id: sessionId, workspaceId }
        : null;
      const state = findWorkspaceStack(navigation.getRootState());
      if (!state) return;
      const previous = previousSession.current;
      previousSession.current = next;
      const route = state.routes[state.index ?? 0]?.name;
      if (shouldResetSessionNavigation(previous, next, route)) {
        // One owner resets private history; login/logout remain Protected transitions.
        navigation.resetRoot({ key: state.key, index: 0, routes: [{ name: "(tabs)" }] });
      }
    };
    updateNavigation();
    const stopReady = navigation.addListener("ready", updateNavigation);
    const stopState = navigation.addListener("state", updateNavigation);
    return () => { stopReady(); stopState(); };
  }, [ready, sessionId, workspaceId, navigation]);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <Stack
      // Retire stale route content without replacing the native navigator.
      screenLayout={({ children }) => (
        <WorkspaceScreen workspaceId={workspaceId}>{children}</WorkspaceScreen>
      )}
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
          name="manage/document/[id]"
          options={{ presentation: "formSheet", headerShown: true,
            sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true }}
        />
        <Stack.Screen
          name="manage/database/[id]"
          options={{ presentation: "formSheet", headerShown: true, gestureEnabled: false }}
        />
        <Stack.Screen
          name="manage/view/[id]"
          options={{ presentation: "formSheet", headerShown: true, gestureEnabled: false }}
        />
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
  // A diagnostic Release is a separate synthetic artifact, never the daily-use candidate.
  if (diagnosticsEnabled(
    __DEV__,
    process.env.EXPO_PUBLIC_MH_SELFTEST,
    process.env.EXPO_PUBLIC_MH_DIAGNOSTICS_RELEASE,
  )) {
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
