import { Button, Text } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize, disabled, font, frame, tint } from "@expo/ui/swift-ui/modifiers";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { useTheme } from "@/lib/theme";
import type { SettingsButtonProps } from "./settings-button";

export function SettingsButton({ label, onPress, disabled: isDisabled, variant = "filled", destructive }: SettingsButtonProps) {
  const { tokens } = useTheme();
  const glass = isLiquidGlassAvailable();
  return (
    <Button onPress={onPress} role={destructive ? "destructive" : "default"} modifiers={[
      buttonStyle(variant === "text" ? "borderless" : glass
        ? variant === "filled" ? "glassProminent" : "glass"
        : variant === "filled" ? "borderedProminent" : "bordered"),
      controlSize("large"), tint(destructive ? tokens.danger : tokens.accent), disabled(!!isDisabled),
    ]}>
      <Text modifiers={[
        font({ textStyle: "body", weight: variant === "filled" ? "semibold" : "regular" }),
        frame({ maxWidth: Infinity, minHeight: 28, alignment: variant === "text" ? "leading" : "center" }),
      ]}>{label ?? ""}</Text>
    </Button>
  );
}
