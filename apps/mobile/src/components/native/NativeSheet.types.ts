import type { BottomSheetProps } from "@expo/ui";

/** Short native content only; long forms belong in a Router form sheet. */
export type NativeSheetProps = Pick<
  BottomSheetProps,
  "isPresented" | "onDismiss" | "children" | "showDragIndicator" | "testID"
> & {
  /** Disable backdrop/back dismissal while an operation must finish. */
  dismissible?: boolean;
};
