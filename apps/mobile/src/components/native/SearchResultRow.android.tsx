import { Icon, ListItem, Text } from "@expo/ui/jetpack-compose";
import { clickable, fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";
import { useTheme } from "@/lib/theme";
import { NativeHost } from "./NativeHost";
import type { SearchResultRowProps } from "./SearchPresentation";

export function SearchResultRow({ hit, onPress }: SearchResultRowProps) {
  const { tokens } = useTheme();
  const document = hit.type === "document";
  const snippet = hit.snippet?.replace(/\s+/g, " ").trim();
  return <NativeHost matchContents={{ vertical: true }}>
    <ListItem modifiers={[fillMaxWidth(), clickable(onPress)]}
      colors={{ containerColor: tokens.bg, contentColor: tokens.fg, leadingContentColor: tokens.fgSoft }}>
      <ListItem.LeadingContent>
        <Icon source={document ? require("./assets/document.xml") : require("./assets/table.xml")} size={24} />
      </ListItem.LeadingContent>
      <ListItem.OverlineContent>
        <Text color={tokens.fgSoft} style={{ typography: "labelSmall" }}>{document ? "文档" : "数据表记录"}</Text>
      </ListItem.OverlineContent>
      <ListItem.HeadlineContent>
        <Text maxLines={2} overflow="ellipsis" style={{ typography: "titleMedium" }}>{hit.title || "未命名"}</Text>
      </ListItem.HeadlineContent>
      {!!snippet && <ListItem.SupportingContent>
        <Text maxLines={2} overflow="ellipsis" color={tokens.fgSoft} style={{ typography: "bodyMedium" }}>{snippet}</Text>
      </ListItem.SupportingContent>}
    </ListItem>
  </NativeHost>;
}
