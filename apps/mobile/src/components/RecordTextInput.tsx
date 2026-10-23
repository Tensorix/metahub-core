import { TextInput, useNativeState, type TextInputProps } from "@expo/ui";
import { useEffect } from "react";

/** The installed Expo UI captures defaultValue only on mount. */
export function RecordTextInput({ text, ...props }: Omit<TextInputProps, "value" | "defaultValue"> & { text: string }) {
  const state = useNativeState(text);
  useEffect(() => {
    // Expo UI ObservableState is intentionally mutable; its setter updates native text.
    // eslint-disable-next-line react-hooks/immutability
    if (state.value !== text) state.value = text;
  }, [state, text]);
  return <TextInput {...props} value={state} />;
}
