import { Button } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonStyle,
  frame,
  labelStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { NativeHost } from "../native/NativeHost";
import { useTheme } from "@/lib/theme";
import type { ToolbarIconProps } from "./ToolbarIcon";
const symbols = {
  search: "magnifyingglass",
  filter: "line.3.horizontal.decrease",
  sort: "arrow.up.arrow.down",
  settings: "slider.horizontal.3",
} as const;
export function ToolbarIcon({ kind, label, onPress }: ToolbarIconProps) {
  const { scheme } = useTheme();
  return (
    <NativeHost matchContents>
      <Button
        label={label}
        systemImage={symbols[kind]}
        onPress={onPress}
        modifiers={[
          buttonStyle("borderless"),
          labelStyle("iconOnly"),
          frame({ width: 36, height: 36 }),
          tint(scheme === "dark" ? "#fff" : "#000"),
          accessibilityLabel(label),
        ]}
      />
    </NativeHost>
  );
}
