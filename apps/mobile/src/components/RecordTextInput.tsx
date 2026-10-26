import { TextInput, useNativeState, type TextInputProps } from "@expo/ui";
import { useEffect } from "react";

import { useTheme } from "@/lib/theme";

export type RecordTextInputProps = Omit<TextInputProps, "value" | "defaultValue"> & {
  text: string;
};

/** Observable native text stays editable between renders and accepts loaded/reset drafts. */
export function RecordTextInput({ text, textStyle, ...props }: RecordTextInputProps) {
  const { tokens } = useTheme();
  const state = useNativeState(text);
  useEffect(() => {
    // Expo UI ObservableState is intentionally mutable; its setter updates native text.
    // eslint-disable-next-line react-hooks/immutability
    if (state.value !== text) state.value = text;
  }, [state, text]);
  return (
    <TextInput
      cursorColor={tokens.accent}
      placeholderTextColor={tokens.muted}
      {...props}
      textStyle={{ color: tokens.fg, ...textStyle }}
      value={state}
    />
  );
}
