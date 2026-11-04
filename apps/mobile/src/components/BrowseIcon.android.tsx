import { Icon } from "@expo/ui/jetpack-compose";
import { NativeHost } from "./native/NativeHost";
import { useTheme } from "@/lib/theme";
const sources = {
  document: require("./native/assets/document.xml"),
  database: require("./native/assets/table.xml"),
  site: require("./native/assets/site.xml"),
  more: require("./native/assets/more.xml"),
};
export function BrowseIcon({
  kind,
  size = 22,
}: {
  kind: keyof typeof sources;
  size?: number;
}) {
  const { tokens } = useTheme();
  return (
    <NativeHost matchContents>
      <Icon source={sources[kind]} size={size} tint={tokens.accent} />
    </NativeHost>
  );
}
