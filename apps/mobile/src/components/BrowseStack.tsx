import { Stack } from "expo-router/stack";
import { Platform } from "react-native";
import { useTheme } from "@/lib/theme";
export default function BrowseStack() {
  const { tokens, scheme } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerTintColor: tokens.fg,
        contentStyle: { backgroundColor: tokens.bg },
        headerBackButtonDisplayMode: "minimal",
        ...(Platform.OS === "ios"
          ? {
              headerTransparent: true,
              headerShadowVisible: false,
              headerLargeTitleShadowVisible: false,
              headerLargeStyle: { backgroundColor: "transparent" },
              headerLargeTitleEnabled: true,
              headerBlurEffect: "none",
            }
          : {
              headerStyle: { backgroundColor: tokens.bg },
              headerShadowVisible: false,
              statusBarStyle: scheme === "dark" ? "light" : "dark",
            }),
      }}
    />
  );
}
