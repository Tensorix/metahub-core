import { Stack } from "expo-router";
import { useTheme } from "@/lib/theme";
export default function HomeLayout() {
  const { tokens } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: tokens.bg },
        headerTintColor: tokens.fg,
        contentStyle: { backgroundColor: tokens.bg },
        headerBackButtonDisplayMode: "minimal",
      }}
    />
  );
}
