import { Button, type ButtonProps } from "@expo/ui";

export type SettingsButtonProps = ButtonProps & { destructive?: boolean };
export function SettingsButton({ destructive: _destructive, ...props }: SettingsButtonProps) {
  return <Button {...props} />;
}
