import { Column, ModalBottomSheet, type ModalBottomSheetRef } from "@expo/ui/jetpack-compose";
import { padding, testID as testIDModifier } from "@expo/ui/jetpack-compose/modifiers";
import { useEffect, useRef, useState } from "react";

import { NativeHost } from "./NativeHost";
import type { NativeSheetProps } from "./NativeSheet.types";

export type { NativeSheetProps } from "./NativeSheet.types";

/** Avoid the SDK 57 universal sheet's internal unseeded Host. */
export function NativeSheet({
  isPresented, onDismiss, children, showDragIndicator = true, testID, dismissible = true,
}: NativeSheetProps) {
  const sheet = useRef<ModalBottomSheetRef>(null);
  const [mounted, setMounted] = useState(isPresented);

  // Retain the native sheet during its hide animation; opening mounts before commit.
  if (isPresented && !mounted) setMounted(true);

  useEffect(() => {
    if (isPresented) return;
    let cancelled = false;
    void sheet.current?.hide().then(() => {
      if (!cancelled) setMounted(false);
    });
    return () => { cancelled = true; };
  }, [isPresented]);

  if (!mounted) return null;
  return (
    <NativeHost style={{ position: "absolute" }} pointerEvents="none">
      <ModalBottomSheet
        ref={sheet}
        onDismissRequest={onDismiss}
        showDragHandle={showDragIndicator}
        sheetGesturesEnabled={dismissible}
        properties={{ shouldDismissOnBackPress: dismissible, shouldDismissOnClickOutside: dismissible }}
      >
        <Column modifiers={[padding(16, showDragIndicator ? 0 : 16, 16, 24), ...(testID ? [testIDModifier(testID)] : [])]}>
          {children}
        </Column>
      </ModalBottomSheet>
    </NativeHost>
  );
}
