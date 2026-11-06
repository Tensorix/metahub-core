import { Icon } from "@expo/ui";
import { NativeButton } from "../native/NativeButton";
import { useTheme } from "@/lib/theme";
export type ToolbarIconProps = {
  kind: "search" | "filter" | "sort" | "settings";
  label: string;
  onPress(): void;
};
const icons = {
  search: require("../native/assets/db-search.xml"),
  filter: require("../native/assets/db-filter.xml"),
  sort: require("../native/assets/editor-numbered.xml"),
  settings: require("../native/assets/more.xml"),
};
export function ToolbarIcon({ kind, label, onPress }: ToolbarIconProps) {
  const { tokens } = useTheme();
  return (
    <NativeButton
      variant="text"
      onPress={onPress}
      style={{ width: 40, height: 40 }}
    >
      <Icon
        name={icons[kind]}
        color={tokens.fg}
        size={22}
        accessibilityLabel={label}
      />
    </NativeButton>
  );
}
