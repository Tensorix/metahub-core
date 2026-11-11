import { Button, Text } from "@expo/ui/swift-ui";
import { Platform } from "react-native";
import {
  buttonStyle,
  controlSize,
  disabled,
  font,
  frame,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { NativeHost } from "./native/NativeHost";
import { useTheme } from "@/lib/theme";
import type { ShareActionProps } from "./share-action.types";

export function ShareAction({
  label,
  onPress,
  disabled: isDisabled = false,
  primary = false,
  danger = false,
}: ShareActionProps) {
  const { tokens } = useTheme();
  const supportsGlass = Number.parseInt(String(Platform.Version), 10) >= 26;
  return (
    <NativeHost matchContents={{ vertical: true }} style={{ minHeight: 52 }}>
      <Button
        role={danger ? "destructive" : "default"}
        onPress={onPress}
        modifiers={[
          buttonStyle(
            primary
              ? supportsGlass
                ? "glassProminent"
                : "borderedProminent"
              : danger
                ? "borderless"
                : supportsGlass
                  ? "glass"
                  : "bordered",
          ),
          controlSize("large"),
          tint(danger ? tokens.danger : tokens.accent),
          disabled(isDisabled),
        ]}
      >
        <Text
          modifiers={[
            font({ design: "default", weight: "semibold" }),
            frame({ maxWidth: Infinity, minHeight: 28 }),
          ]}
        >
          {label}
        </Text>
      </Button>
    </NativeHost>
  );
}
