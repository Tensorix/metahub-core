import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { Platform, Pressable, StyleSheet, Text } from "react-native";
import { useTheme } from "@/lib/theme";

export function ScannerButton({
  label,
  onPress,
  primary = false,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  const { scheme, tokens } = useTheme();
  const glass = Platform.OS === "ios" && isLiquidGlassAvailable();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        borderRadius: 24,
        paddingHorizontal: 24,
        alignSelf: primary ? "center" : "stretch",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: glass
          ? "transparent"
          : primary
            ? tokens.accent
            : tokens.surface2,
        opacity: pressed ? 0.72 : 1,
      })}
    >
      {glass && (
        <GlassView
          pointerEvents="none"
          isInteractive
          colorScheme={scheme}
          tintColor={primary ? tokens.accent : undefined}
          style={[StyleSheet.absoluteFill, { borderRadius: 24 }]}
        />
      )}
      <Text
        style={{
          fontSize: 17,
          fontWeight: primary ? "600" : "500",
          color: primary ? tokens.accentFg : tokens.accent,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
