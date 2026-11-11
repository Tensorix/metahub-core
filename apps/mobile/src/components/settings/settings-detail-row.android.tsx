import { ListItem, type ListItemProps } from "@expo/ui";
import { useTheme } from "@/lib/theme";

export function SettingsDetailRow(props: ListItemProps) {
  const { tokens } = useTheme();
  return <ListItem {...props} colors={{ containerColor: tokens.bg, contentColor: tokens.fg, supportingContentColor: tokens.fgSoft }} />;
}
