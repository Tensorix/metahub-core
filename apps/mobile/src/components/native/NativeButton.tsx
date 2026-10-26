import { Button, type ButtonProps } from "@expo/ui";

import { NativeHost, type NativeHostProps } from "./NativeHost";
import { nativeButtonContent } from "./button-content";

/** A native button island for RN layouts. Within a NativeHost use @expo/ui Button directly. */
export function NativeButton({
  hostStyle,
  label,
  children,
  ...props
}: ButtonProps & { hostStyle?: NativeHostProps["style"] }) {
  return (
    <NativeHost matchContents style={hostStyle}>
      <Button {...props} {...nativeButtonContent(label, children)} />
    </NativeHost>
  );
}
