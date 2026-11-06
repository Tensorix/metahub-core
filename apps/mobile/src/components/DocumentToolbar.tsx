import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { useEffect, useState } from "react";
import { Keyboard, Platform, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeButton } from "./native/NativeButton";
import { useTheme } from "@/lib/theme";
import type { EditorState } from "@/lib/editor/protocol";

const labels: Record<EditorState, string> = {
  saved: "已保存", dirty: "保存中…", saving: "保存中…", conflict: "保存冲突", error: "保存失败",
};

/** Native controls stay outside the WebView so opening a picker preserves its selection. */
export function DocumentToolbar({ state, disabled, onAttach }: {
  state: EditorState;
  disabled: boolean;
  onAttach(kind: "image" | "video" | "file"): void;
}) {
  const { tokens } = useTheme();
  const insets = useSafeAreaInsets();
  const [keyboardVisible, setKeyboardVisible] = useState(Keyboard.isVisible());
  useEffect(() => {
    // KeyboardAvoidingView owns positioning; these events only remove the home-indicator inset.
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setKeyboardVisible(true));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const glass = Platform.OS === "ios" && isLiquidGlassAvailable();
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: keyboardVisible ? 8 : Math.max(insets.bottom, 8) }}>
      <GlassView glassEffectStyle="regular" style={{
        borderRadius: 16, paddingHorizontal: 8, paddingVertical: 4,
        backgroundColor: glass ? undefined : tokens.surface2,
      }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always"
            style={{ flex: 1 }} contentContainerStyle={{ alignItems: "center", gap: 4 }}>
            {([
              ["image", "照片"], ["video", "视频"], ["file", "附件"],
            ] as const).map(([kind, label]) => (
              <NativeButton key={kind} label={label} variant="text" disabled={disabled}
                style={{ height: 44, paddingHorizontal: 12 }} onPress={() => onAttach(kind)} />
            ))}
          </ScrollView>
          <Text accessibilityLiveRegion="polite" style={{ fontSize: 12, flexShrink: 0, paddingRight: 4,
            color: state === "error" || state === "conflict" ? tokens.danger : tokens.fgSoft }}>
            {labels[state]}
          </Text>
        </View>
      </GlassView>
    </View>
  );
}
