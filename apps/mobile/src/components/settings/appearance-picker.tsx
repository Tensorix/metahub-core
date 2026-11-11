import { Picker } from "@expo/ui";
import { useTheme, type ThemePref } from "@/lib/theme";

export function AppearancePicker() {
  const { pref, setPref } = useTheme();
  return <Picker selectedValue={pref} onValueChange={(value: ThemePref) => setPref(value)}>
    <Picker.Item value="system" label="跟随系统" />
    <Picker.Item value="light" label="浅色" />
    <Picker.Item value="dark" label="深色" />
  </Picker>;
}
