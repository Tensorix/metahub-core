import { useRef, useLayoutEffect, useCallback } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { LibrarySwitch } from "./LibrarySwitch";
import type { ListProps } from "./LibraryList.types";
import { replacementAnchor, type Row } from "../../lib/browse/library";
import { useTheme } from "../../lib/theme";
export function LibraryList(p: ListProps) {
  const { tokens } = useTheme();
  const list = useRef<FlatList<Row>>(null);
  const first = useRef<string | null>(null);
  const previous = useRef(p.rows);
  useLayoutEffect(() => {
    const target = replacementAnchor(first.current, previous.current, p.rows);
    if (target)
      list.current?.scrollToIndex({
        index: p.rows.findIndex((row) => row.key === target),
        animated: false,
      });
    previous.current = p.rows;
  }, [p.rows]);
  const latest = useRef(p);
  useLayoutEffect(() => {
    latest.current = p;
  }, [p]);
  const visible = useCallback(
    ({ viewableItems }: { viewableItems: { item: Row }[] }) => {
      first.current =
        viewableItems.find(({ item }) => !item.more)?.item.key ?? null;
      for (const { item } of viewableItems)
        if (item.more && !item.error) latest.current.more(item);
    },
    [],
  );
  return (
    <FlatList
      ref={list}
      onScrollToIndexFailed={({ index, averageItemLength }) =>
        list.current?.scrollToOffset({
          offset: index * averageItemLength,
          animated: false,
        })
      }
      data={p.rows}
      keyExtractor={(r) => r.key}
      onViewableItemsChanged={visible}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      refreshControl={
        <RefreshControl refreshing={p.refreshing} onRefresh={p.refresh} />
      }
      ListHeaderComponent={
        <View>
          <LibrarySwitch value={p.kind} onChange={p.changeKind} />
          {!!p.error && <Text onPress={p.refresh}>{p.error} · 重试</Text>}
        </View>
      }
      ListEmptyComponent={
        <Text style={{ color: tokens.fgSoft }}>暂无匹配资料</Text>
      }
      renderItem={({ item }) => (
        <View
          style={{
            minHeight: 64,
            flexDirection: "row",
            alignItems: "center",
            paddingLeft: 16 + Math.min(item.depth, 6) * 12,
          }}
        >
          {item.children && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                (item.expanded ? "折叠" : "展开") + item.title
              }
              onPress={() => p.toggle(item)}
              style={{ padding: 12 }}
            >
              <Text style={{ color: tokens.fg }}>
                {item.expanded ? "⌄" : "›"}
              </Text>
            </Pressable>
          )}
          <Pressable
            style={{ flex: 1, paddingVertical: 12 }}
            accessibilityRole="button"
            onPress={() => (item.more ? p.more(item) : p.open(item))}
          >
            <Text style={{ color: tokens.fg, fontSize: 17 }}>{item.title}</Text>
            {!!item.path && (
              <Text style={{ color: tokens.fgSoft }}>{item.path}</Text>
            )}
          </Pressable>
        </View>
      )}
    />
  );
}
