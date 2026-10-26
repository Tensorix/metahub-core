import { Button, Menu } from "@expo/ui/swift-ui";
import { disabled } from "@expo/ui/swift-ui/modifiers";

import { NativeHost } from "./NativeHost";
import type { NativeMenuProps } from "./NativeMenu.types";

export type { NativeMenuItem, NativeMenuProps } from "./NativeMenu.types";

export function NativeMenu({ label, items, testID }: NativeMenuProps) {
  return (
    <NativeHost matchContents>
      <Menu label={label} testID={testID}>
        {items.map((item) => (
          <Button
            key={item.id}
            label={item.title}
            role={item.destructive ? "destructive" : "default"}
            modifiers={[disabled(!!item.disabled)]}
            onPress={item.onPress}
          />
        ))}
      </Menu>
    </NativeHost>
  );
}
