import { invalidateEditorRuntime } from "@/lib/editor/warmup";
import {
  ThemeProvider as NavigationThemeProvider,
  DarkTheme,
  DefaultTheme,
} from "expo-router/react-navigation";
import { SyncUpgradePrompt } from "@/components/SyncUpgradePrompt";
import { NativeDiagnostics } from "@/lib/diagnostics/NativeDiagnostics";
import { diagnosticsEnabled } from "@/lib/diagnostics/build-mode";
import {
  Stack,
  useRootNavigationState,
  useNavigationContainerRef,
} from "expo-router";
import { Platform } from "react-native";
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
function WorkspaceScreen({
  workspaceId,
  children,
}: {
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
  const navigationState = useRootNavigationState();
  const previousSession = useRef<SessionIdentity | null | undefined>(undefined);
  const sessionId = session?.id;
  const workspaceId = session?.workspaceId;
  useEffect(() => () => { if (workspaceId && sessionId !== undefined) invalidateEditorRuntime(workspaceId, String(sessionId)); }, [workspaceId, sessionId]);
  useEffect(() => {
    const updateNavigation = () => {
      if (!ready || !navigation.isReady()) return;
      const next =
        sessionId !== undefined && workspaceId !== undefined
          ? { id: sessionId, workspaceId }
          : null;
      const state = findWorkspaceStack(navigation.getRootState());
      if (!state) return;
      const previous = previousSession.current;
      previousSession.current = next;
      const route = state.routes[state.index ?? 0]?.name;
      if (shouldResetSessionNavigation(previous, next, route)) {
        // One owner resets private history; login/logout remain Protected transitions.
        navigation.reset({
          key: state.key,
          index: 0,
          routes: [{ name: "(tabs)" }],
        });
      }
    };
    updateNavigation();
    const stopState = navigation.addListener("state", updateNavigation);
    return () => {
      stopState();
    };
  }, [ready, sessionId, workspaceId, navigation, navigationState?.key]);

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
          name="find"
          options={{ headerShown: true, title: "搜索" }}
        />
        <Stack.Screen
          name="sites"
          options={{
            headerShown: true,
            title: "Sites",
            headerLargeTitleEnabled: Platform.OS === "ios",
          }}
        />
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
        <Stack.Screen
          name="doc/[id]"
          options={{
            headerShown: true,
            headerTransparent: false,
            headerStyle: { backgroundColor: tokens.bg },
          }}
        />
        <Stack.Screen
          name="manage/document/[id]"
          // Android form sheets do not support navigation headers or their save/cancel actions.
          options={{
            presentation: Platform.OS === "android" ? "modal" : "formSheet",
            headerShown: true,
            ...(Platform.OS === "ios"
              ? { sheetAllowedDetents: [0.75, 1], sheetGrabberVisible: true }
              : {}),
          }}
        />
        <Stack.Screen
          name="manage/database/[id]"
          options={{
            presentation: Platform.OS === "android" ? "modal" : "formSheet",
            headerShown: true,
            gestureEnabled: false,
          }}
        />
        <Stack.Screen
          name="manage/view/[id]"
          options={{
            presentation: Platform.OS === "android" ? "modal" : "formSheet",
            headerShown: true,
            gestureEnabled: false,
          }}
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
      <Stack.Screen
        name="connect"
        options={{ headerShown: true, title: "连接存储桶" }}
      />
    </Stack>
  );
}

function ThemedNavigation() {
  const { scheme, tokens } = useTheme();
  const theme = scheme === "dark" ? DarkTheme : DefaultTheme;
  return (
    <NavigationThemeProvider
      value={{
        ...theme,
        colors: {
          ...theme.colors,
          primary: tokens.accent,
          background: tokens.bg,
          card: tokens.bg,
          text: tokens.fg,
          border: tokens.line,
        },
      }}
    >
      <SyncUpgradePrompt />
      <RootStack />
    </NavigationThemeProvider>
  );
}

export default function RootLayout() {
  // A diagnostic Release is a separate synthetic artifact, never the daily-use candidate.
  if (
    diagnosticsEnabled(
      __DEV__,
      process.env.EXPO_PUBLIC_MH_SELFTEST,
      process.env.EXPO_PUBLIC_MH_DIAGNOSTICS_RELEASE,
    )
  ) {
    void SplashScreen.hideAsync();
    return <NativeDiagnostics />;
  }
  return (
    <ThemeProvider>
      <SessionProvider>
        <ThemedNavigation />
      </SessionProvider>
    </ThemeProvider>
  );
}
