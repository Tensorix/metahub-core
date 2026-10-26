import { Button } from "@expo/ui";
import { DropdownMenu, DropdownMenuItem, Text } from "@expo/ui/jetpack-compose";
import { useState } from "react";

import { useTheme } from "@/lib/theme";

import { NativeHost } from "./NativeHost";
import type { NativeMenuProps } from "./NativeMenu.types";

export type { NativeMenuItem, NativeMenuProps } from "./NativeMenu.types";

/** SDK 57 has no universal Menu. Keep the Compose menu in the seeded host. */
export function NativeMenu({ label, items, testID }: NativeMenuProps) {
  const [expanded, setExpanded] = useState(false);
  const { tokens } = useTheme();
  return (
    <NativeHost matchContents>
      <DropdownMenu expanded={expanded} onDismissRequest={() => setExpanded(false)}>
        <DropdownMenu.Trigger>
          <Button label={label} variant="text" testID={testID} onPress={() => setExpanded(true)} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Items>
          {items.map((item) => (
            <DropdownMenuItem
              key={item.id}
              enabled={!item.disabled}
              elementColors={item.destructive ? { textColor: tokens.danger } : undefined}
              onClick={() => {
                setExpanded(false);
                item.onPress();
              }}
            >
              <DropdownMenuItem.Text><Text>{item.title}</Text></DropdownMenuItem.Text>
            </DropdownMenuItem>
          ))}
        </DropdownMenu.Items>
      </DropdownMenu>
    </NativeHost>
  );
}
