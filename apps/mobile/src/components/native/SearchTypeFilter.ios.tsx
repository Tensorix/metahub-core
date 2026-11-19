import { Picker, Text } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  controlSize,
  frame,
  glassEffect,
  padding,
  pickerStyle,
  scaleEffect,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { KeyboardAvoidingView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeHost } from "./NativeHost";
import type { SearchTypeFilterProps } from "./SearchTypeFilter";

const scopes = [
  { label: "全部", value: "all" },
  { label: "文档", value: "document" },
  { label: "记录", value: "record" },
] as const;

export function SearchTypeFilter({ value, onChange }: SearchTypeFilterProps) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      behavior="padding"
      pointerEvents="box-none"
      style={styles.overlay}
    >
      <View
        pointerEvents="box-none"
        style={{
          alignItems: "center",
          paddingBottom: Math.max(insets.bottom, 54) + 4,
        }}
      >
        <NativeHost ignoreSafeArea="all" style={styles.control}>
          <Picker
            label="搜索范围"
            selection={value ?? "all"}
            onSelectionChange={(next) =>
              onChange(next === "all" ? undefined : next)
            }
            modifiers={[
              pickerStyle("segmented"),
              controlSize("regular"),
              frame({ maxWidth: Infinity }),
              ...(isLiquidGlassAvailable()
                ? [
                    padding({ all: 3 }),
                    glassEffect({
                      shape: "capsule",
                      glass: { variant: "regular", interactive: true },
                    }),
                  ]
                : []),
              scaleEffect(0.9),
              accessibilityLabel("搜索范围"),
            ]}
          >
            {scopes.map((scope) => (
              <Text key={scope.value} modifiers={[tag(scope.value)]}>
                {scope.label}
              </Text>
            ))}
          </Picker>
        </NativeHost>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, justifyContent: "flex-end" },
  // Match the library picker’s 84 pt per segment before scaling.
  control: { width: 84 * scopes.length, maxWidth: "100%", height: 44 },
});
