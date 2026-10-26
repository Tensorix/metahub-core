import { Button, type ButtonProps } from "@expo/ui";

export type NativeFormButtonProps = Omit<ButtonProps, "children" | "modifiers"> & {
  label: string;
  selected?: boolean;
};

/** One action per FieldGroup row. Android keeps the native button variants. */
export function NativeFormButton({
  selected,
  variant,
  ...props
}: NativeFormButtonProps) {
  return (
    <Button
      {...props}
      variant={selected === undefined ? variant : selected ? "filled" : "text"}
    />
  );
}
