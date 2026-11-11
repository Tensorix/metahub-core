import type { PropsWithChildren } from "react";
import { Column, Text } from "@expo/ui/jetpack-compose";
import { fillMaxWidth, padding } from "@expo/ui/jetpack-compose/modifiers";
import { useTheme } from "@/lib/theme";

export function SettingsSection({ title, children }: PropsWithChildren<{ title?: string }>) {
  const { tokens } = useTheme();
  return <Column modifiers={[fillMaxWidth(), padding(8, 8, 8, 16)]}>
    {title && <Text color={tokens.accent} style={{ typography: "titleSmall" }}
      modifiers={[padding(16, 16, 16, 8)]}>{title}</Text>}
    {children}
  </Column>;
}
