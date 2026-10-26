import { Stack } from "expo-router";
import { Platform } from "react-native";

import { NativeButton } from "./NativeButton";

type NativeToolbarActionProps = {
  placement: "left" | "right";
  label: string;
  disabled?: boolean;
  onPress: () => void;
  variant?: "done";
  tintColor?: string;
};

/** Android toolbar buttons require icons; use a native text button for named actions. */
export function NativeToolbarAction({
  placement,
  label,
  disabled,
  onPress,
  variant,
  tintColor,
}: NativeToolbarActionProps) {
  if (Platform.OS === "android") {
    return (
      <Stack.Toolbar placement={placement} asChild>
        <NativeButton variant="text" disabled={disabled} onPress={onPress}>
          {label}
        </NativeButton>
      </Stack.Toolbar>
    );
  }
  // Keep iOS items serialized through the native toolbar rather than a custom header view.
  return (
    <Stack.Toolbar placement={placement} tintColor={tintColor}>
      <Stack.Toolbar.Button variant={variant} disabled={disabled} onPress={onPress}>
        {label}
      </Stack.Toolbar.Button>
    </Stack.Toolbar>
  );
}
