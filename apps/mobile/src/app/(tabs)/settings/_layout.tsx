import { StatusBar } from "expo-status-bar";
import { Stack } from "expo-router";
import { Platform } from "react-native";
import { useTheme } from "@/lib/theme";
export default function SettingsLayout() {
  const { tokens, scheme } = useTheme();
  return <><StatusBar style={scheme === "dark" ? "light" : "dark"} /><Stack screenOptions={{ headerTintColor: tokens.fg, contentStyle: { backgroundColor: tokens.bg }, headerBackButtonDisplayMode: "minimal", ...(Platform.OS === "ios" ? { headerTransparent: true, headerStyle: { backgroundColor: "transparent" }, scrollEdgeEffects: { top: "hidden" }, headerBlurEffect: "none", headerShadowVisible: false, headerLargeTitleShadowVisible: false, headerLargeStyle: { backgroundColor: "transparent" } } : { headerStyle: { backgroundColor: tokens.bg }, headerShadowVisible: false, statusBarStyle: scheme === "dark" ? "light" : "dark" }) }}>
    <Stack.Screen name="index" options={{ title: "设置", headerLargeTitleEnabled: Platform.OS === "ios" }} />
  </Stack></>;
}
