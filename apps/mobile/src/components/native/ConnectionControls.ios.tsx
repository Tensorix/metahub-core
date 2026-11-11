import { Button, Picker, Text } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonStyle,
  controlSize,
  disabled,
  font,
  frame,
  pickerStyle,
  tag,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { useTheme } from "@/lib/theme";
import type {
  ConnectionActionProps,
  ConnectionChoiceProps,
} from "./ConnectionControls";

export function ConnectionChoice<T extends string>(
  props: ConnectionChoiceProps<T>,
) {
  return (
    <Picker
      label={props.label}
      selection={props.value}
      onSelectionChange={props.onChange}
      modifiers={[
        pickerStyle("segmented"),
        controlSize("large"),
        frame({ maxWidth: Infinity, minHeight: 44 }),
        accessibilityLabel(props.label),
        disabled(props.disabled),
      ]}
    >
      {props.options.map((option) => (
        <Text key={option.value} modifiers={[tag(option.value)]}>
          {option.label}
        </Text>
      ))}
    </Picker>
  );
}

export function ConnectionAction(props: ConnectionActionProps) {
  const { tokens } = useTheme();
  return (
    <Button
      onPress={props.onPress}
      modifiers={[
        buttonStyle(
          isLiquidGlassAvailable() ? "glassProminent" : "borderedProminent",
        ),
        controlSize("large"),
        tint(tokens.accent),
        disabled(props.disabled),
      ]}
    >
      <Text
        modifiers={[
          font({ weight: "semibold" }),
          frame({ maxWidth: Infinity, minHeight: 28 }),
        ]}
      >
        {props.label}
      </Text>
    </Button>
  );
}
