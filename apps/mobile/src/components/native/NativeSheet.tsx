import { BottomSheet } from "@expo/ui";

import { useTheme } from "@/lib/theme";

import { NativeHost } from "./NativeHost";
import type { NativeSheetProps } from "./NativeSheet.types";

export type { NativeSheetProps } from "./NativeSheet.types";

/** Children must be Expo UI native components. */
export function NativeSheet({ dismissible = true, ...props }: NativeSheetProps) {
  const { tokens } = useTheme();
  return (
    <NativeHost>
      <BottomSheet
        {...props}
        containerColor={tokens.surface}
        contentColor={tokens.fg}
        shouldDismissOnBackPress={dismissible}
        shouldDismissOnClickOutside={dismissible}
      />
    </NativeHost>
  );
}
