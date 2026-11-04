import { Pressable, Text, View } from "react-native";
import { useTheme } from "@/lib/theme";
import type { LibrarySwitchProps } from "./LibrarySwitch.types";
export function LibrarySwitch({ value, onChange }: LibrarySwitchProps) {
  const { tokens } = useTheme();
  return (
    <View style={{ flexDirection: "row" }}>
      {(["documents", "databases"] as const).map((kind) => (
        <Pressable
          key={kind}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === kind }}
          onPress={() => onChange(kind)}
          style={{
            flex: 1,
            padding: 14,
            backgroundColor:
              value === kind ? tokens.accentSoft : tokens.surface,
          }}
        >
          <Text style={{ color: tokens.fg, textAlign: "center" }}>
            {kind === "documents" ? "文档" : "数据表"}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
