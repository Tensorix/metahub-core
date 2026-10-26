import { MenuView } from "@expo/ui/community/menu";
import { Text } from "react-native";

import { useTheme } from "@/lib/theme";

import type { NativeMenuProps } from "./NativeMenu.types";

export type { NativeMenuItem, NativeMenuProps } from "./NativeMenu.types";

export function NativeMenu({ label, items, testID }: NativeMenuProps) {
  const { scheme, tokens } = useTheme();
  return (
    <MenuView
      colorScheme={scheme}
      testID={testID}
      actions={items.map(({ id, title, disabled, destructive }) => ({
        id, title, attributes: { disabled, destructive },
      }))}
      onPressAction={({ nativeEvent }) => items.find((item) => item.id === nativeEvent.event)?.onPress()}
    >
      <Text accessibilityRole="button" style={{ color: tokens.accent, padding: 12 }}>{label}</Text>
    </MenuView>
  );
}
