import { Button } from "@expo/ui";

import { NativeHost } from "./NativeHost";
import type { MaterialFabProps } from "./MaterialFab.types";

/** Web fallback; iOS creation actions belong in the screen toolbar. */
export function MaterialFab({ label, onPress }: MaterialFabProps) {
  return (
    <NativeHost matchContents>
      <Button label={label} onPress={onPress} />
    </NativeHost>
  );
}
