import { BottomSheet, Group } from "@expo/ui/swift-ui";
import {
  frame, interactiveDismissDisabled, padding, presentationDragIndicator,
} from "@expo/ui/swift-ui/modifiers";

import { NativeHost } from "./NativeHost";
import type { NativeSheetProps } from "./NativeSheet.types";

export type { NativeSheetProps } from "./NativeSheet.types";

/** Preserve the selected SwiftUI tint in the presenting host and its sheet. */
export function NativeSheet({
  isPresented, onDismiss, children, showDragIndicator = true, testID, dismissible = true,
}: NativeSheetProps) {
  return (
    <NativeHost style={{ position: "absolute" }} pointerEvents="none">
      <BottomSheet
        isPresented={isPresented}
        onIsPresentedChange={(presented) => { if (!presented) onDismiss(); }}
        fitToContents
        testID={testID}
      >
        <Group modifiers={[
          frame({ maxWidth: Infinity, alignment: "topLeading" }),
          padding({ top: 16, bottom: 24, leading: 16, trailing: 16 }),
          presentationDragIndicator(showDragIndicator ? "visible" : "hidden"),
          interactiveDismissDisabled(!dismissible),
        ]}>
          {children}
        </Group>
      </BottomSheet>
    </NativeHost>
  );
}
