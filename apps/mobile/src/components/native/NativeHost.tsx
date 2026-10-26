import { Host, type UniversalHostProps } from "@expo/ui";
import { Platform } from "react-native";

import { useTheme } from "@/lib/theme";
import { light } from "@/lib/theme/tokens";

export type NativeHostProps = Omit<UniversalHostProps, "colorScheme" | "seedColor">;

/** Keep every native island on the same appearance and palette as the RN shell. */
export function NativeHost(props: NativeHostProps) {
  const { scheme, tokens, materialYou, dynamicAvailable } = useTheme();
  return (
    <Host
      {...props}
      colorScheme={scheme}
      seedColor={Platform.OS === "android"
        ? (materialYou && dynamicAvailable ? undefined : light.accent)
        : tokens.accent}
    />
  );
}
