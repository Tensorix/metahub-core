import { useEdgeScroll } from "./useEdgeScroll";
import { useRefData, referenceIds } from "../RefField";
import { rectangle } from "@/lib/grid-selection";
import { DragItem } from "./DragItem";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import {
  type NativeScrollEvent,
  Animated,
  ScrollView,
  View,
  Text,
  Pressable,
  TextInput,
} from "react-native";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import type { PropInfo, RecordInfo } from "@/lib/api/sdk";
import { cellText } from "@/lib/format";
import { useTheme } from "@/lib/theme";
function ReferenceCell({
  prop,
  value,
  wrap,
}: {
  prop: PropInfo;
  value: unknown;
  wrap: boolean;
}) {
  const { refDisplay } = useRefData([prop], { [prop.id]: value });
  const { tokens } = useTheme();
  return (
    <Text
      numberOfLines={wrap ? undefined : 1}
      style={{ color: tokens.fg, fontSize: 16 }}
    >
      {referenceIds(value).length ? refDisplay(prop, value) : " "}
    </Text>
  );
}
const positions = new Map<string, { x: number; y: number }>();
export type Cell = { record: string; prop: string };
export function Grid({
  stateKey,
  records,
  props,
  active,
  range,
  onRangeFocus,
  onRangeAnchor,
  editing,
  value,
  selected,
  wrap,
  calc,
  onCell,
  onRange,
  onSelect,
  onOpen,
  onHeader,
  onAdd,
  onMore,
  onText,
  onDone,
}: {
  stateKey: string;
  records: RecordInfo[];
  props: PropInfo[];
  active: Cell | null;
  range: Cell | null;
  onRangeFocus(c: Cell): void;
  onRangeAnchor(c: Cell): void;
  editing: Cell | null;
  value: unknown;
  selected: Set<string>;
  wrap: boolean;
  calc: Record<string, string>;
  onCell(c: Cell): void;
  onRange(c: Cell): void;
  onSelect(id: string): void;
  onOpen(id: string): void;
  onHeader(p: PropInfo | null): void;
  onAdd(): void;
  onMore(): void;
  onText(v: string): void;
  onDone(): void;
}) {
  const { tokens } = useTheme();
  const {
    attach: attachHorizontal,
    measure: measureHorizontal,
    onScroll: scrollHorizontal,
    onContentSizeChange: sizeHorizontal,
    move: moveHorizontal,
    stop: stopHorizontal,
  } = useEdgeScroll(true);
  const {
    attach: attachVertical,
    measure: measureVertical,
    onScroll: scrollVertical,
    onContentSizeChange: sizeVertical,
    move: moveVertical,
    stop: stopVertical,
  } = useEdgeScroll(false);
  const vertical = useRef<FlashListRef<RecordInfo>>(null);
  const cellNodes = useRef(new Map<string, ComponentRef<typeof View>>());
  const horizontal = useRef<ComponentRef<typeof ScrollView>>(null);
  const [scrollX] = useState(() => new Animated.Value(0));
  useEffect(() => {
    horizontal.current?.scrollTo({
      x: positions.get(stateKey)?.x ?? 0,
      animated: false,
    });
  }, [stateKey]);
  const widths = props.map((p) =>
    Math.max(88, Math.min(400, p.config?.width ?? 160)),
  );
  const rangeCells =
    range && active ? rectangle(records, props, range, active) : [];
  const selectedCells = new Set(
    rangeCells.flat().map((c) => c.record + ":" + c.prop),
  );
  const [handleOrigin, setHandleOrigin] = useState<{
    kind: "anchor" | "focus";
    cell: Cell;
  } | null>(null);
  const moveHandle = (x: number, y: number, kind: "anchor" | "focus") => {
    moveHorizontal(x);
    moveVertical(y);
    for (const row of records)
      for (const prop of props) {
        cellNodes.current
          .get(row.id + ":" + prop.id)
          ?.measureInWindow((left, top, w, h) => {
            if (x >= left && x < left + w && y >= top && y < top + h)
              (kind === "anchor" ? onRangeAnchor : onRangeFocus)({
                record: row.id,
                prop: prop.id,
              });
          });
      }
  };
  const editingRow = editing
    ? records.findIndex((r) => r.id === editing.record)
    : -1;
  const editingColumn = editing
    ? props.findIndex((p) => p.id === editing.prop)
    : -1;
  const editingX = widths
    .slice(0, Math.max(0, editingColumn))
    .reduce((sum, w) => sum + w, 0);
  useEffect(() => {
    if (editingRow >= 0)
      vertical.current?.scrollToIndex({
        index: editingRow,
        viewPosition: 0.4,
        animated: true,
      });
    if (editingColumn >= 0)
      horizontal.current?.scrollTo({ x: editingX, animated: true });
  }, [editingRow, editingColumn, editingX]);
  const width = widths.reduce((a, b) => a + b, 0) + 76;
  const line = {
    borderBottomWidth: 1,
    borderRightWidth: 1,
    borderColor: tokens.line,
  };
  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      <Animated.ScrollView
        ref={(node) => {
          horizontal.current = node;
          attachHorizontal(node);
        }}
        onLayout={measureHorizontal}
        onContentSizeChange={sizeHorizontal}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { x: scrollX } } }],
          {
            useNativeDriver: true,
            listener: (e) => {
              scrollHorizontal(e as Parameters<typeof scrollHorizontal>[0]);
              positions.set(stateKey, {
                x: (e.nativeEvent as NativeScrollEvent).contentOffset.x,
                y: positions.get(stateKey)?.y ?? 0,
              });
            },
          },
        )}
        scrollEventThrottle={16}
        horizontal
        directionalLockEnabled
        keyboardShouldPersistTaps="always"
        contentContainerStyle={{ width: width + 44 }}
      >
        <View style={{ width: width + 44, flex: 1 }}>
          <View
            style={{
              flexDirection: "row",
              height: 44,
              backgroundColor: tokens.surface2,
            }}
          >
            <Animated.View
              style={{
                width: 76,
                zIndex: 2,
                backgroundColor: tokens.surface2,
                transform: [{ translateX: scrollX }],
              }}
            />
            {props.map((p, i) => (
              <Pressable
                key={p.id}
                onPress={() => onHeader(p)}
                style={[line, { width: widths[i], padding: 10 }]}
              >
                <Text
                  numberOfLines={1}
                  style={{ color: tokens.fg, fontWeight: "600" }}
                >
                  {p.name}
                </Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => onHeader(null)}
              style={{ padding: 12 }}
              accessibilityLabel="新增字段"
            >
              <Text style={{ color: tokens.fg }}>＋</Text>
            </Pressable>
          </View>
          <FlashList
            ref={vertical}
            onLoad={() => {
              attachVertical(
                (vertical.current?.getNativeScrollRef() ??
                  null) as unknown as ComponentRef<typeof ScrollView> | null,
              );
              measureVertical();
              vertical.current?.scrollToOffset({
                offset: positions.get(stateKey)?.y ?? 0,
                animated: false,
              });
            }}
            onContentSizeChange={sizeVertical}
            onScroll={(e) => {
              scrollVertical(e);
              positions.set(stateKey, {
                x: positions.get(stateKey)?.x ?? 0,
                y: e.nativeEvent.contentOffset.y,
              });
            }}
            data={records}
            keyExtractor={(r) => r.id}
            extraData={{ active, editing, value, selected, range }}
            onEndReached={onMore}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="interactive"
            onScrollBeginDrag={onDone}
            renderItem={({ item, index }) => (
              <View style={{ flexDirection: "row", minHeight: 44 }}>
                <Animated.View
                  style={{
                    width: 76,
                    flexDirection: "row",
                    zIndex: 2,
                    transform: [{ translateX: scrollX }],
                  }}
                >
                  <Pressable
                    onPress={() => onSelect(item.id)}
                    accessibilityLabel={`选择第 ${index + 1} 行`}
                    style={[
                      line,
                      {
                        width: 44,
                        padding: 10,
                        backgroundColor: selected.has(item.id)
                          ? tokens.accentSoft
                          : tokens.surface2,
                      },
                    ]}
                  >
                    <Text style={{ color: tokens.fg }}>{index + 1}</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => onOpen(item.id)}
                    accessibilityLabel={`打开第 ${index + 1} 行详情`}
                    style={{
                      width: 32,
                      justifyContent: "center",
                      alignItems: "center",
                      backgroundColor: tokens.surface2,
                    }}
                  >
                    <Text style={{ color: tokens.muted }}>↗</Text>
                  </Pressable>
                </Animated.View>
                {props.map((p, i) => {
                  const c = { record: item.id, prop: p.id },
                    isActive =
                      active?.record === item.id && active.prop === p.id,
                    isEditing =
                      editing?.record === item.id && editing.prop === p.id;
                  return (
                    <Pressable
                      key={p.id}
                      ref={(node) => {
                        const key = item.id + ":" + p.id;
                        if (node) cellNodes.current.set(key, node);
                        else cellNodes.current.delete(key);
                      }}
                      onPress={() => onCell(c)}
                      onLongPress={() => onRange(c)}
                      delayLongPress={350}
                      style={[
                        line,
                        {
                          width: widths[i],
                          minHeight: 44,
                          padding: 8,
                          backgroundColor:
                            isActive || selectedCells.has(item.id + ":" + p.id)
                              ? tokens.accentSoft
                              : tokens.bg,
                        },
                      ]}
                    >
                      {range &&
                        (["anchor", "focus"] as const).map((kind) => {
                          const endpoint =
                            handleOrigin?.kind === kind
                              ? handleOrigin.cell
                              : kind === "anchor"
                                ? range
                                : active;
                          if (
                            endpoint?.record !== item.id ||
                            endpoint.prop !== p.id
                          )
                            return null;
                          return (
                            <View
                              key={kind}
                              style={{
                                position: "absolute",
                                ...(kind === "anchor"
                                  ? { left: -10, top: -10 }
                                  : { right: -10, bottom: -10 }),
                                zIndex: 10,
                              }}
                            >
                              <DragItem
                                delay={0}
                                onBegin={() =>
                                  setHandleOrigin({ kind, cell: c })
                                }
                                onFinish={() => {
                                  setHandleOrigin(null);
                                  stopHorizontal();
                                  stopVertical();
                                }}
                                onMove={(point) =>
                                  moveHandle(point.x, point.y, kind)
                                }
                                onDrop={(point) =>
                                  moveHandle(point.x, point.y, kind)
                                }
                              >
                                <View
                                  accessibilityLabel={
                                    kind === "anchor"
                                      ? "拖动选区起点"
                                      : "拖动选区终点"
                                  }
                                  style={{
                                    width: 28,
                                    height: 28,
                                    alignItems: "center",
                                    justifyContent: "center",
                                  }}
                                >
                                  <View
                                    style={{
                                      width: 12,
                                      height: 12,
                                      borderRadius: 6,
                                      backgroundColor: tokens.accent,
                                    }}
                                  />
                                </View>
                              </DragItem>
                            </View>
                          );
                        })}
                      {isEditing ? (
                        <TextInput
                          autoFocus
                          value={String(value ?? "")}
                          onChangeText={onText}
                          onBlur={onDone}
                          onSubmitEditing={onDone}
                          keyboardType={
                            p.type === "number"
                              ? "decimal-pad"
                              : p.type === "url"
                                ? "url"
                                : "default"
                          }
                          style={{ color: tokens.fg, padding: 0, fontSize: 16 }}
                        />
                      ) : p.type === "relation" || p.type === "doc" ? (
                        <ReferenceCell
                          prop={p}
                          value={item.cells[p.id]}
                          wrap={wrap}
                        />
                      ) : (
                        <Text
                          numberOfLines={wrap ? undefined : 1}
                          style={{ color: tokens.fg, fontSize: 16 }}
                        >
                          {cellText(p, item.cells[p.id]) || " "}
                        </Text>
                      )}
                    </Pressable>
                  );
                })}
              </View>
            )}
            ListFooterComponent={
              <View>
                <View style={{ flexDirection: "row", paddingLeft: 76 }}>
                  {props.map((p, i) => (
                    <Pressable
                      key={p.id}
                      onPress={() => onHeader(p)}
                      style={{ width: widths[i], padding: 8 }}
                    >
                      <Text style={{ color: tokens.muted }}>
                        {calc[p.id] ?? ""}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Pressable onPress={onAdd} style={{ padding: 14 }}>
                  <Text style={{ color: tokens.fg }}>＋ 新建记录</Text>
                </Pressable>
              </View>
            }
          />
        </View>
      </Animated.ScrollView>
    </View>
  );
}
