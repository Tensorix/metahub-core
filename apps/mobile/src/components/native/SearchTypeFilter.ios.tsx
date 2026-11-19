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
import { useEffect, useState } from "react";
import { Keyboard, KeyboardAvoidingView, StyleSheet, View } from "react-native";
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
  const [keyboardVisible, setKeyboardVisible] = useState(Keyboard.isVisible());
  useEffect(() => {
    const show = Keyboard.addListener("keyboardWillShow", (event) => {
      setKeyboardVisible(event.endCoordinates.height > 0);
    });
    const hide = Keyboard.addListener("keyboardWillHide", () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  // The field starts 48 + 8 pt above the keyboard, or 7 pt inside the tab bar.
  const searchFieldTopInset = keyboardVisible ? 56 : Math.max(insets.bottom, 54) - 7;
  // The scaled glass already leaves about 2 pt inside its host.
  const bottomPadding = searchFieldTopInset + 4;
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
          paddingBottom: bottomPadding,
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
  control: { width: 84 * scopes.length, maxWidth: "100%", height: 37 },
});
