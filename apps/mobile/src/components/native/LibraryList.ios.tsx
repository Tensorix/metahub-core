import { useCallback, useLayoutEffect, useRef } from "react";
import {
  useNativeState,
  Button,
  Image,
  HStack,
  List,
  ZStack,
  Picker,
  Text,
  VStack,
  Spacer,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  accessibilityHidden,
  buttonStyle,
  listStyle,
  onAppear,
  scrollPosition,
  scrollTargetLayout,
  id,
  frame,
  padding,
  alignmentGuide,
  listRowInsets,
  listRowBackground,
  listRowSeparator,
  contentShape,
  shapes,
  foregroundStyle,
  pickerStyle,
  tag,
  refreshable,
} from "@expo/ui/swift-ui/modifiers";
import { NativeHost } from "./NativeHost";
import type { ListProps } from "./LibraryList.types";
import { replacementAnchor, type Row } from "../../lib/browse/library";
export function LibraryList({
  rows,
  kind,
  changeKind,
  more,
  refresh,
  error,
  toggle,
  open,
}: ListProps) {
  const anchor = useNativeState<string | null>(null);
  const previous = useRef(rows);
  useLayoutEffect(() => {
    const target = replacementAnchor(anchor.value, previous.current, rows);
    if (target) anchor.set(target);
    previous.current = rows;
  }, [anchor, rows]);
  const render = useCallback(
    ({ item }: { item: Row }) => {
      if (item.more)
        return item.error ? (
          <Button label={item.title} onPress={() => more(item)} />
        ) : (
          <Text modifiers={[onAppear(() => more(item))]}>{item.title}</Text>
        );
      const indent = Math.min(item.depth, 6) * 16;
      const symbol =
        kind === "databases"
          ? "tablecells"
          : item.children
            ? "doc.on.doc"
            : "doc.text";
      return (
        <HStack
          spacing={0}
          modifiers={[
            id(item.key),
            padding({ leading: indent }),
            listRowInsets({ top: 4, bottom: 4, leading: 4, trailing: 16 }),
            alignmentGuide("listRowSeparatorLeading", indent + 44 + 28 + 8),
          ]}
        >
          {item.children ? (
            <Button
              onPress={() => toggle(item)}
              modifiers={[
                buttonStyle("plain"),
                accessibilityLabel(
                  (item.expanded ? "折叠" : "展开") + item.title,
                ),
              ]}
            >
              <Image
                systemName={item.expanded ? "chevron.down" : "chevron.right"}
                size={14}
                modifiers={[
                  foregroundStyle({ type: "hierarchical", style: "secondary" }),
                  frame({ width: 44, height: 44 }),
                  contentShape(shapes.rectangle()),
                ]}
              />
            </Button>
          ) : (
            <Spacer modifiers={[frame({ width: 44 })]} />
          )}
          <Button
            onPress={() => open(item)}
            modifiers={[
              buttonStyle("plain"),
              accessibilityLabel(
                item.path ? item.title + "，" + item.path : item.title,
              ),
            ]}
          >
            <HStack
              spacing={8}
              modifiers={[
                frame({ minHeight: 44 }),
                contentShape(shapes.rectangle()),
              ]}
            >
              <Image
                systemName={symbol}
                size={20}
                modifiers={[
                  frame({ width: 28 }),
                  foregroundStyle({ type: "hierarchical", style: "secondary" }),
                ]}
              />
              <VStack alignment="leading">
                <Text>{item.title}</Text>
                {!!item.path && <Text>{item.path}</Text>}
              </VStack>
              <Spacer minLength={0} />
            </HStack>
          </Button>
        </HStack>
      );
    },
    [kind, more, toggle, open],
  );
  return (
    <NativeHost style={{ flex: 1 }}>
      <ZStack alignment="top">
        <List
          modifiers={[
            listStyle("plain"),
            refreshable(refresh),
            scrollPosition(anchor, { anchor: "top" }),
          ]}
        >
          {/* Scroll this clearance away so content can pass behind the glass. */}
          <Text modifiers={[
            frame({ height: 48 }),
            listRowInsets({ top: 0, bottom: 0 }),
            listRowSeparator("hidden"),
            listRowBackground("clear"),
            accessibilityHidden(true),
          ]}>{" "}</Text>
          {!!error && (
            <Button label={error + " · 重试"} onPress={() => void refresh()} />
          )}
          {!rows.length && <Text>暂无匹配资料</Text>}
          <List.ForEach
            estimatedItemSize={44}
            modifiers={[scrollTargetLayout()]}
            data={rows}
            keyExtractor={(row) => row.key}
          >
            {render}
          </List.ForEach>
        </List>
        <Picker
          label="资料类型"
          selection={kind}
          onSelectionChange={changeKind}
          modifiers={[
            pickerStyle("segmented"),
            frame({ width: 160, height: 36 }),
            padding({ top: 4, horizontal: 16 }),
          ]}
        >
          <Text modifiers={[tag("documents")]}>文档</Text>
          <Text modifiers={[tag("databases")]}>数据表</Text>
        </Picker>
      </ZStack>
    </NativeHost>
  );
}
