import { DOCUMENT_TOOLBAR_ACTIONS } from "./document-toolbar-actions";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { useEffect, useState } from "react";
import { Keyboard, Platform, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DocumentToolbarButton } from "./DocumentToolbarButton";
import { useTheme } from "@/lib/theme";
import type { EditorState, EditorBlockType } from "@/lib/editor/protocol";

const labels: Record<EditorState, string> = {
  saved: "已保存", dirty: "保存中…", saving: "保存中…", conflict: "保存冲突", error: "保存失败",
};

/** Native controls stay outside the WebView so opening a picker preserves its selection. */
export function DocumentToolbar({ state, disabled, onAttach, onBlock }: {
  state: EditorState;
  disabled: boolean;
  onBlock(type: EditorBlockType): void;
  onAttach(kind: "library" | "image" | "video" | "audio" | "file"): void;
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
    <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: keyboardVisible ? 4 : Math.max(insets.bottom - 4, 4) }}>
      <GlassView glassEffectStyle="regular" style={{
        borderRadius: 16, paddingHorizontal: 8, paddingVertical: 2,
        backgroundColor: glass ? undefined : tokens.surface2,
      }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always"
            style={{ flex: 1 }} contentContainerStyle={{ alignItems: "center", gap: 4 }}>
            {DOCUMENT_TOOLBAR_ACTIONS.map(({kind, label}) => (
              <DocumentToolbarButton key={kind} kind={kind} label={label} disabled={disabled}
                onPress={() => kind === "library" || kind === "file" || kind === "audio" ? onAttach(kind) : onBlock(kind)} />
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
