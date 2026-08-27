import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "@/lib/theme";

const GLASS = Platform.OS === "ios" && isLiquidGlassAvailable();

/** Floating action button. iOS 26: interactive liquid glass circle;
 *  elsewhere: accent-filled circle with shadow (M3 FAB polish in M4). */
export function AdaptiveFab({
  glyph = "＋",
  label,
  onPress,
}: {
  glyph?: string;
  label?: string;
  onPress: () => void;
}) {
  const { tokens } = useTheme();

  if (GLASS) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label ?? glyph}
        onPress={onPress}
        style={styles.anchor}
      >
        <GlassView style={styles.fab} glassEffectStyle="regular" isInteractive>
          <Text style={[styles.glyph, { color: tokens.fg }]}>{glyph}</Text>
        </GlassView>
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? glyph}
      onPress={onPress}
      style={styles.anchor}
    >
      <View
        style={[
          styles.fab,
          styles.solid,
          { backgroundColor: tokens.accent, shadowColor: "#000" },
        ]}
      >
        <Text style={[styles.glyph, { color: tokens.accentFg }]}>{glyph}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Clear of the floating iOS 26 tab bar (and Android nav bar) — the tab
  // capsule occupies roughly the bottom 90pt on tab screens.
  anchor: { position: "absolute", right: 20, bottom: 110 },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  solid: {
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  glyph: { fontSize: 26, fontWeight: "400", lineHeight: 30 },
});
