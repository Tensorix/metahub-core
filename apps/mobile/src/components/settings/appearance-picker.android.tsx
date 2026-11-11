import { Column, ListItem, RadioButton, Text } from "@expo/ui/jetpack-compose";
import { fillMaxWidth, selectable, selectableGroup } from "@expo/ui/jetpack-compose/modifiers";
import { useTheme, type ThemePref } from "@/lib/theme";

const options: { value: ThemePref; title: string }[] = [
  { value: "system", title: "跟随系统" },
  { value: "light", title: "浅色" },
  { value: "dark", title: "深色" },
];
export function AppearancePicker() {
  const { pref, setPref, tokens } = useTheme();
  return <Column modifiers={[fillMaxWidth(), selectableGroup()]}>
    {options.map(({ value, title }) => <ListItem key={value}
      colors={{ containerColor: tokens.bg, contentColor: tokens.fg }}
      modifiers={[fillMaxWidth(), selectable(pref === value, () => setPref(value), "radioButton")]}>
      <ListItem.LeadingContent><RadioButton selected={pref === value} /></ListItem.LeadingContent>
      <ListItem.HeadlineContent><Text>{title}</Text></ListItem.HeadlineContent>
    </ListItem>)}
  </Column>;
}
