import { NativeTabs } from "expo-router/native-tabs";
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { warmEditorSurface } from "@/lib/editor/warmup";
import { AppState, Platform } from "react-native";

import { useTheme } from "@/lib/theme";

export default function TabsLayout() {
  const { tokens } = useTheme();
  useFocusEffect(useCallback(() => {
    if (Platform.OS !== "ios") return;
    const idle = requestIdleCallback(warmEditorSurface);
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") warmEditorSurface();
    });
    return () => { cancelIdleCallback(idle); subscription.remove(); };
  }, []));

  return (
    <NativeTabs
      tintColor={tokens.accent}
      iconColor={{ default: tokens.muted, selected: tokens.accent }}
      labelStyle={{
        default: { color: tokens.muted },
        selected: { color: tokens.accent },
      }}
      // iOS retains the system glass treatment; Android uses the app's M3 roles.
      {...(Platform.OS === "android"
        ? { backgroundColor: tokens.sidebar, indicatorColor: tokens.accentSoft }
        : {})}
    >
      <NativeTabs.Trigger
        name="(home)"
        testID="tab-home"
        accessibilityLabel="首页"
      >
        <NativeTabs.Trigger.Label>首页</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "house", selected: "house.fill" }}
          md="home"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger
        name="(library)"
        testID="tab-library"
        accessibilityLabel="资料库"
      >
        <NativeTabs.Trigger.Label>资料库</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "books.vertical", selected: "books.vertical.fill" }}
          md="folder"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger
        name="settings"
        testID="tab-settings"
        accessibilityLabel="设置"
      >
        <NativeTabs.Trigger.Label>设置</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "gearshape", selected: "gearshape.fill" }}
          md="settings"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger
        name="(search)"
        role="search"
        hidden={Platform.OS === "android"}
        testID="tab-search"
        accessibilityLabel="搜索"
      >
        <NativeTabs.Trigger.Label>搜索</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
