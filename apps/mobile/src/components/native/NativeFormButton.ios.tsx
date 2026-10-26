import { Button } from "@expo/ui";
import { buttonStyle } from "@expo/ui/swift-ui/modifiers";

import type { NativeFormButtonProps } from "./NativeFormButton";

/** Form owns the whole row's hit region with automatic style. Keep each button
 * in a separate row; plain/bordered styles restrict hits to their label. */
export function NativeFormButton({
  selected,
  label,
  ...props
}: NativeFormButtonProps) {
  return (
    <Button
      {...props}
      label={selected ? `✓ ${label}` : label}
      modifiers={[buttonStyle("automatic")]}
    />
  );
}
