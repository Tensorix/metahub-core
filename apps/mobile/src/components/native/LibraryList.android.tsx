import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { FlatList, RefreshControl, View } from "react-native";
import {
  DropdownMenu, DropdownMenuItem, Icon, IconButton, ListItem,
  Row as ComposeRow, Spacer, Text,
} from "@expo/ui/jetpack-compose";
import { combinedClickable, fillMaxWidth, size } from "@expo/ui/jetpack-compose/modifiers";
import { replacementAnchor, type Row } from "@/lib/browse/library";
import { useTheme } from "@/lib/theme";
import { EmptyState } from "../EmptyState";
import { NativeButton } from "./NativeButton";
import { NativeHost } from "./NativeHost";
import { LibrarySwitch } from "./LibrarySwitch";
import { useDocumentMenu } from "./use-document-menu";
import type { ListProps } from "./LibraryList.types";

/** Keep paged data and scroll anchors in FlatList; Compose owns each native row. */
export function LibraryList(p: ListProps) {
  const { tokens } = useTheme();
  const [menuId, setMenuId] = useState<string | null>(null);
  const list = useRef<FlatList<Row>>(null);
  const first = useRef<string | null>(null);
  const previous = useRef(p.rows);
  const latest = useRef(p);
  useLayoutEffect(() => {
    const target = replacementAnchor(first.current, previous.current, p.rows);
    if (target) list.current?.scrollToIndex({
      index: p.rows.findIndex((row) => row.key === target), animated: false,
    });
    previous.current = p.rows;
    latest.current = p;
  }, [p]);
  const visible = useCallback(({ viewableItems }: { viewableItems: { item: Row }[] }) => {
    first.current = viewableItems.find(({ item }) => !item.more)?.item.key ?? null;
    for (const { item } of viewableItems) {
      if (item.more && !item.error) latest.current.more(item);
    }
  }, []);
  return (
    <FlatList
      ref={list}
      data={p.rows}
      extraData={menuId}
      keyExtractor={(row) => row.key}
      onScrollBeginDrag={() => setMenuId(null)}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingBottom: 96, flexGrow: 1 }}
      onScrollToIndexFailed={({ index, averageItemLength }) =>
        list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false })}
      onViewableItemsChanged={visible}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      refreshControl={<RefreshControl refreshing={p.refreshing} onRefresh={p.refresh} colors={[tokens.accent]} />}
      ListHeaderComponent={
        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
          <LibrarySwitch value={p.kind} onChange={(kind) => { setMenuId(null); p.changeKind(kind); }} />
          {!!p.error && <NativeButton label={`${p.error} · 重试`} variant="text" onPress={p.refresh} />}
        </View>
      }
      ListEmptyComponent={<EmptyState title="暂无匹配资料" hint="试试其他关键词，或切换资料类型" />}
      renderItem={({ item }) => item.more ? (
        <View style={{ padding: 16 }}>
          <NativeButton label={item.title} variant="text" onPress={() => p.more(item)} />
        </View>
      ) : (
        <LibraryRow
          item={item} actions={p.actions} kind={p.kind}
          open={p.open} toggle={p.toggle}
          expanded={menuId === item.key}
          showMenu={() => setMenuId(item.key)} closeMenu={() => setMenuId(null)}
        />
      )}
    />
  );
}

function LibraryRow({ item, actions, kind, open, toggle, expanded, showMenu, closeMenu }: {
  item: Row;
  actions: ListProps["actions"];
  kind: ListProps["kind"];
  open: ListProps["open"];
  toggle: ListProps["toggle"];
  expanded: boolean;
  showMenu(): void;
  closeMenu(): void;
}) {
  const { tokens } = useTheme();
  const menu = useDocumentMenu(item.key, actions);
  const show = () => { menu.refresh(); showMenu(); };
  return (
    <NativeHost matchContents={{ vertical: true }} style={{ marginStart: Math.min(item.depth, 3) * 16 }}>
      <ListItem
        colors={{ containerColor: tokens.bg, contentColor: tokens.fg, leadingContentColor: tokens.fgSoft, trailingContentColor: tokens.fgSoft }}
        modifiers={[fillMaxWidth(), combinedClickable({ onClick: () => { closeMenu(); open(item); }, onLongClick: show })]}
      >
        <ListItem.LeadingContent>
          <ComposeRow verticalAlignment="center">
            {item.children ? (
              <IconButton modifiers={[size(48, 48)]} onClick={() => { closeMenu(); toggle(item); }}>
                <Icon source={item.expanded ? require("./assets/expand-more.xml") : require("./assets/chevron-right.xml")} size={24}
                  contentDescription={`${item.expanded ? "折叠" : "展开"}${item.title}`} />
              </IconButton>
            ) : (
              <Spacer modifiers={[size(48, 48)]} />
            )}
            <Icon source={kind === "documents" ? require("./assets/document.xml") : require("./assets/table.xml")} size={24} />
          </ComposeRow>
        </ListItem.LeadingContent>
        <ListItem.HeadlineContent>
          <Text maxLines={2} overflow="ellipsis" style={{ typography: "bodyLarge" }}>{item.title || "未命名"}</Text>
        </ListItem.HeadlineContent>
        {!!item.path && <ListItem.SupportingContent>
          <Text maxLines={1} overflow="ellipsis" color={tokens.fgSoft}>{item.path}</Text>
        </ListItem.SupportingContent>}
        <ListItem.TrailingContent>
            <DropdownMenu expanded={expanded} onDismissRequest={closeMenu}>
              <DropdownMenu.Trigger>
                <IconButton modifiers={[size(48, 48)]} onClick={show}>
                  <Icon source={require("./assets/more-vert.xml")} size={24} contentDescription={`${item.title}，更多操作`} />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Items>
                {menu.items.map((action) => <DropdownMenuItem
                  key={action.id} enabled={menu.available}
                  elementColors={action.destructive ? { textColor: tokens.danger } : undefined}
                  onClick={() => { closeMenu(); actions.perform(item.key, action.id); }}
                >
                  <DropdownMenuItem.Text><Text>{action.title}</Text></DropdownMenuItem.Text>
                </DropdownMenuItem>)}
              </DropdownMenu.Items>
            </DropdownMenu>
        </ListItem.TrailingContent>
      </ListItem>
    </NativeHost>
  );
}
