import { NativeTabs } from "expo-router/unstable-native-tabs";
import { Platform } from "react-native";

import { useTheme } from "@/lib/theme";

export default function TabsLayout() {
  const { tokens } = useTheme();

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
      <NativeTabs.Trigger name="(home)" testID="tab-home" accessibilityLabel="首页">
        <NativeTabs.Trigger.Label>首页</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "house", selected: "house.fill" }}
          md="home"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" testID="tab-search" accessibilityLabel="搜索">
        <NativeTabs.Trigger.Label>搜索</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings" testID="tab-settings" accessibilityLabel="设置">
        <NativeTabs.Trigger.Label>设置</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "gearshape", selected: "gearshape.fill" }}
          md="settings"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
