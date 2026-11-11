import { Icon, ListItem, Text } from "@expo/ui/jetpack-compose";
import { clickable, fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";
import { useTheme } from "@/lib/theme";

const icons: Record<string, number> = {
  "sun.max": require("../native/assets/settings-appearance.xml"),
  internaldrive: require("../native/assets/settings-storage.xml"),
  folder: require("../native/assets/settings-folder.xml"),
  "arrow.triangle.2.circlepath": require("../native/assets/settings-sync.xml"),
  "info.circle": require("../native/assets/settings-info.xml"),
};
export function SettingsRow({ title, value, icon, onPress }: {
  title: string; value?: string; icon: string; onPress(): void;
}) {
  const { tokens } = useTheme();
  return <ListItem
    colors={{ containerColor: tokens.bg, contentColor: tokens.fg, leadingContentColor: tokens.fgSoft, trailingContentColor: tokens.fgSoft }}
    modifiers={[fillMaxWidth(), clickable(onPress)]}>
    <ListItem.LeadingContent><Icon source={icons[icon] ?? icons["info.circle"]!} size={24} /></ListItem.LeadingContent>
    <ListItem.HeadlineContent><Text style={{ typography: "bodyLarge" }}>{title}</Text></ListItem.HeadlineContent>
    {!!value && <ListItem.SupportingContent><Text color={tokens.fgSoft} maxLines={2} overflow="ellipsis">{value}</Text></ListItem.SupportingContent>}
    <ListItem.TrailingContent><Icon source={require("../native/assets/chevron-right.xml")} size={24} /></ListItem.TrailingContent>
  </ListItem>;
}
