import { TextInput, useNativeState, type TextInputProps } from "@expo/ui";
import { useEffect, useState } from "react";

import { useTheme } from "@/lib/theme";
import { createNativeTextBridge } from "@/lib/native-text-bridge";

export type RecordTextInputProps = Omit<
  TextInputProps,
  "value" | "defaultValue"
> & {
  text: string;
  /** Change to force an external reset even when its text equals a pending edit. */
  resetKey?: string | number;
};

/** Observable native text stays editable between renders and accepts loaded/reset drafts. */
export function RecordTextInput({
  text,
  textStyle,
  onChangeText,
  resetKey,
  ...props
}: RecordTextInputProps) {
  const { tokens } = useTheme();
  const state = useNativeState(text);
  const [bridge] = useState(() => createNativeTextBridge(text, resetKey));
  useEffect(() => {
    if (bridge.reconcile(text, resetKey) && state.get() !== text)
      state.set(text);
  }, [bridge, state, text, resetKey]);
  return (
    <TextInput
      cursorColor={tokens.accent}
      placeholderTextColor={tokens.muted}
      {...props}
      textStyle={{ color: tokens.fg, ...textStyle }}
      value={state}
      onChangeText={(value) => {
        // Register before the callback can synchronously update a parent draft.
        if (onChangeText) {
          bridge.nativeChanged(value);
          onChangeText(value);
        }
      }}
    />
  );
}
