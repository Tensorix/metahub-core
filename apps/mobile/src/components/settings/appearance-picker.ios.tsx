import { Picker, Text } from "@expo/ui/swift-ui";
import { labelsHidden, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { useTheme, type ThemePref } from "@/lib/theme";

export function AppearancePicker() {
  const { pref, setPref } = useTheme();
  return <Picker label="外观" selection={pref} onSelectionChange={(value: ThemePref) => setPref(value)} modifiers={[pickerStyle("inline"), labelsHidden()]}>
    <Text modifiers={[tag("system")]}>跟随系统</Text>
    <Text modifiers={[tag("light")]}>浅色</Text>
    <Text modifiers={[tag("dark")]}>深色</Text>
  </Picker>;
}
