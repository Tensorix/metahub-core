import { FloatingActionButton, Icon } from "@expo/ui/jetpack-compose";

import { NativeHost } from "./NativeHost";
import type { MaterialFabProps } from "./MaterialFab.types";

/** Compose owns the shape, elevation, pressed state, and accessibility action. */
export function MaterialFab({ label, onPress, icon }: MaterialFabProps) {
  return (
    <NativeHost matchContents>
      <FloatingActionButton onClick={onPress}>
        <FloatingActionButton.Icon>
          <Icon
            source={icon ?? require("./assets/add.xml")}
            size={24}
            contentDescription={label}
          />
        </FloatingActionButton.Icon>
      </FloatingActionButton>
    </NativeHost>
  );
}
