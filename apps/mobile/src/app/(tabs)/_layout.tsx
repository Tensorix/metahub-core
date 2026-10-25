import { Tabs } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { SymbolView } from "expo-symbols";
import { Platform } from "react-native";

import { useTheme } from "@/lib/theme";

export default function TabsLayout() {
  const { tokens } = useTheme();

  // The tested SDK 57 / iOS 27 Release build showed an empty native tab bar.
  // Keep the routes accessible with Router's UIKit-styled JS tab bar until
  // the native host supports that runtime; Android retains its system bar.
  if (Platform.OS === "ios" && Number.parseInt(String(Platform.Version), 10) >= 27) {
    return (
      <Tabs
        backBehavior="initialRoute"
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: tokens.accent,
          tabBarInactiveTintColor: tokens.muted,
          tabBarStyle: {
            backgroundColor: tokens.surface,
            borderTopColor: tokens.line,
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "首页",
            tabBarAccessibilityLabel: "首页",
            tabBarButtonTestID: "tab-home",
            tabBarIcon: ({ focused, color, size }) => (
              <SymbolView
                name={focused ? "house.fill" : "house"}
                tintColor={color}
                size={size}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="search"
          options={{
            title: "搜索",
            tabBarAccessibilityLabel: "搜索",
            tabBarButtonTestID: "tab-search",
            tabBarIcon: ({ color, size }) => (
              <SymbolView name="magnifyingglass" tintColor={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "设置",
            tabBarAccessibilityLabel: "设置",
            tabBarButtonTestID: "tab-settings",
            tabBarIcon: ({ focused, color, size }) => (
              <SymbolView
                name={focused ? "gearshape.fill" : "gearshape"}
                tintColor={color}
                size={size}
              />
            ),
          }}
        />
      </Tabs>
    );
  }

  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>首页</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "house", selected: "house.fill" }}
          md="home"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search">
        <NativeTabs.Trigger.Label>搜索</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>设置</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "gearshape", selected: "gearshape.fill" }}
          md="settings"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
