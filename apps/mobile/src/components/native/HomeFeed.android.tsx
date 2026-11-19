import { useState } from "react";
import { ScrollView } from "react-native";
import { Icon, ListItem, Text } from "@expo/ui/jetpack-compose";
import { combinedClickable, fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";
import { useTheme } from "@/lib/theme";
import { BrowseOverflowMenu } from "./BrowseOverflowMenu.android";
import { NativeHost } from "./NativeHost";
import type { HomeFeedProps } from "./HomeFeed.types";

export function HomeFeed({ actions, databaseActions, items, openItem, header, empty }: HomeFeedProps) {
  const { tokens } = useTheme();
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const closeMenu = () => setMenuKey(null);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: tokens.bg }}
      contentContainerStyle={{ paddingTop: 8, paddingBottom: 104 }} onScrollBeginDrag={closeMenu}>
      {header}
      {items.map(item => {
        const key = `${item.kind}:${item.id}`;
        const title = item.title || "未命名";
        const document = item.kind === "document";
        const showMenu = () => setMenuKey(key);
        return <NativeHost key={key} matchContents={{ vertical: true }}>
          <ListItem colors={{ containerColor: tokens.bg, contentColor: tokens.fg,
            leadingContentColor: tokens.fgSoft, trailingContentColor: tokens.fgSoft }}
            modifiers={[fillMaxWidth(), combinedClickable({
              onClick: () => { closeMenu(); openItem(item); }, onLongClick: showMenu,
            })]}>
            <ListItem.LeadingContent>
              <Icon source={document ? require("./assets/document.xml") : require("./assets/table.xml")} size={24} />
            </ListItem.LeadingContent>
            <ListItem.HeadlineContent>
              <Text maxLines={2} overflow="ellipsis" style={{ typography: "bodyLarge" }}>{title}</Text>
            </ListItem.HeadlineContent>
            <ListItem.TrailingContent>
              <BrowseOverflowMenu id={item.id} title={title} actions={document ? actions : databaseActions}
                expanded={menuKey === key} showMenu={showMenu} closeMenu={closeMenu} recent />
            </ListItem.TrailingContent>
          </ListItem>
        </NativeHost>;
      })}
      {empty}
    </ScrollView>
  );
}
