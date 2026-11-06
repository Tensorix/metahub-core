import type { ComponentRef } from "react";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useEdgeScroll } from "./database/useEdgeScroll";
import { DragItem } from "./database/DragItem";
import { useMemo, useState, useRef } from "react";
import {
  useWindowDimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { NativeMenu } from "@/components/native/NativeMenu";
import type { NativeMenuItem } from "@/components/native/NativeMenu.types";
import { RecordCard } from "@/components/RecordCard";
import type { PropInfo, RecordInfo } from "@/lib/api/sdk";
import { chipColor, selectOptions, recordTitle } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

const UNGROUPED = "__ungrouped__";

interface Column {
  key: string;
  label: string;
  records: RecordInfo[];
}

/** Native columns keep independent vertical paging; a held card can move across
 * groups or reorder within one group when the current query permits it. */
export function BoardView({
  records,
  totals,
  onMore,
  props,
  groupProp,
  onOpenRecord,
  onAddRecord,
  onMoveRecord,
  recordActions,
  onMoveColumn,
  onReorderRecord,
}: {
  records: RecordInfo[];
  totals?: Record<string, number>;
  onMore?(group: string | null): void;
  props: PropInfo[];
  groupProp: PropInfo;
  onOpenRecord: (id: string) => void;
  onAddRecord: (presetOption: string | null) => void;
  onMoveRecord: (recordId: string, option: string | null) => void;
  recordActions?: (recordId: string) => NativeMenuItem[];
  onReorderRecord?(id: string, anchor: string, where: "before" | "after"): void;
  onMoveColumn?: (
    option: string,
    anchor: string,
    where: "before" | "after",
  ) => void;
}) {
  const { tokens, scheme } = useTheme();
  const { width } = useWindowDimensions();
  const {
    attach: edgeRef,
    measure: measureEdge,
    onScroll: onEdgeScroll,
    onContentSizeChange: edgeContentSize,
    move: moveEdge,
    stop: stopEdge,
  } = useEdgeScroll(true);
  const targets = useRef(new Map<string, ComponentRef<typeof View>>());
  const {
    attach: attachColumn,
    measure: measureColumn,
    onScroll: scrollColumn,
    onContentSizeChange: sizeColumn,
    move: moveColumnEdge,
    stop: stopColumnEdge,
    reset: resetColumn,
  } = useEdgeScroll(false);
  const lists = useRef(new Map<string, FlashListRef<RecordInfo>>());
  const sizes = useRef(new Map<string, { offset: number; extent: number }>());
  const activeColumn = useRef<string | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const [preview, setPreview] = useState<{
    title: string;
    x: number;
    y: number;
  } | null>(null);
  const cards = useRef(new Map<string, ComponentRef<typeof View>>());
  const [drop, setDrop] = useState<string | null>(null);
  const targetAt = (x: number, y: number, found: (key: string) => void) => {
    targets.current.forEach((node, key) =>
      node.measureInWindow((left, top, w, h) => {
        if (x >= left && x < left + w && y >= top && y < top + h) found(key);
      }),
    );
  };
  const COL_W = Math.min(width * 0.78, 340);

  const columns = useMemo<Column[]>(() => {
    const byOption = new Map<string, RecordInfo[]>();
    const options = selectOptions(groupProp);
    for (const opt of options) byOption.set(opt, []);
    const ungrouped: RecordInfo[] = [];
    for (const rec of records) {
      const v = rec.cells[groupProp.id];
      const list = typeof v === "string" ? byOption.get(v) : undefined;
      if (list) list.push(rec);
      else ungrouped.push(rec);
    }
    const cols: Column[] = options.map((opt) => ({
      key: opt,
      label: opt,
      records: byOption.get(opt) ?? [],
    }));
    cols.push({ key: UNGROUPED, label: "未分组", records: ungrouped });
    return cols;
  }, [records, groupProp]);

  return (
    <View
      style={{ flex: 1 }}
      ref={(node) => {
        node?.measureInWindow((x, y) => {
          origin.current = { x, y };
        });
      }}
    >
      <ScrollView
        ref={edgeRef}
        onLayout={measureEdge}
        onScroll={onEdgeScroll}
        onContentSizeChange={edgeContentSize}
        scrollEventThrottle={16}
        horizontal
        snapToInterval={COL_W + 12}
        decelerationRate="fast"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
      >
        {columns.map((col, index) => (
          <View
            key={col.key}
            ref={(node) => {
              if (node) targets.current.set(col.key, node);
              else targets.current.delete(col.key);
            }}
            style={[
              styles.col,
              {
                width: COL_W,
                backgroundColor: tokens.sidebar,
                borderColor: drop === col.key ? tokens.accent : tokens.line,
              },
            ]}
          >
            <View style={styles.colHead}>
              {col.key !== UNGROUPED ? (
                <View
                  style={[
                    styles.dot,
                    { backgroundColor: chipColor(col.label, scheme) },
                  ]}
                />
              ) : null}
              <Text
                numberOfLines={1}
                style={[styles.colTitle, { color: tokens.fgSoft }]}
              >
                {col.label}
              </Text>
              {onMoveColumn && col.key !== UNGROUPED ? (
                <NativeMenu
                  label="列顺序"
                  items={[
                    {
                      id: "left",
                      title: "左移此列",
                      disabled: !index,
                      onPress: () =>
                        onMoveColumn(
                          col.key,
                          columns[index - 1]!.key,
                          "before",
                        ),
                    },
                    {
                      id: "right",
                      title: "右移此列",
                      disabled: index >= columns.length - 2,
                      onPress: () =>
                        onMoveColumn(col.key, columns[index + 1]!.key, "after"),
                    },
                  ]}
                />
              ) : null}
              <Text style={[styles.colCount, { color: tokens.muted }]}>
                {totals?.[col.key] ?? col.records.length}
              </Text>
            </View>
            <FlashList
              ref={(node) => {
                if (node) lists.current.set(col.key, node);
                else lists.current.delete(col.key);
              }}
              onScroll={(e) => {
                const old = sizes.current.get(col.key);
                sizes.current.set(col.key, {
                  offset: e.nativeEvent.contentOffset.y,
                  extent: old?.extent ?? 0,
                });
                if (activeColumn.current === col.key) scrollColumn(e);
              }}
              onContentSizeChange={(w, h) => {
                const old = sizes.current.get(col.key);
                sizes.current.set(col.key, {
                  offset: old?.offset ?? 0,
                  extent: h,
                });
                if (activeColumn.current === col.key) sizeColumn(w, h);
              }}
              data={col.records}
              onEndReached={() =>
                onMore?.(col.key === UNGROUPED ? null : col.key)
              }
              keyExtractor={(r) => r.id}
              renderItem={({ item }) => (
                <DragItem
                  floating
                  onMove={(p) => {
                    moveEdge(p.x);
                    setPreview({
                      title: recordTitle(item, props),
                      x: p.x - origin.current.x,
                      y: p.y - origin.current.y,
                    });
                    targetAt(p.x, p.y, (key) => {
                      setDrop(key);
                      if (activeColumn.current !== key) {
                        stopColumnEdge();
                        activeColumn.current = key;
                        attachColumn(
                          (lists.current.get(key)?.getNativeScrollRef() ??
                            null) as unknown as ComponentRef<
                            typeof ScrollView
                          > | null,
                        );
                        const size = sizes.current.get(key);
                        resetColumn(size?.offset ?? 0, size?.extent ?? 0);
                        measureColumn();
                      }
                      moveColumnEdge(p.y);
                    });
                  }}
                  onFinish={() => {
                    setDrop(null);
                    setPreview(null);
                    stopEdge();
                    stopColumnEdge();
                    activeColumn.current = null;
                  }}
                  onDrop={(p) =>
                    targetAt(p.x, p.y, (key) => {
                      if (key !== col.key) {
                        onMoveRecord(item.id, key === UNGROUPED ? null : key);
                        return;
                      }
                      if (!onReorderRecord) return;
                      for (const record of col.records)
                        if (record.id !== item.id)
                          cards.current
                            .get(record.id)
                            ?.measureInWindow((x, y, w, h) => {
                              if (
                                p.x >= x &&
                                p.x < x + w &&
                                p.y >= y &&
                                p.y < y + h
                              )
                                onReorderRecord(
                                  item.id,
                                  record.id,
                                  p.y < y + h / 2 ? "before" : "after",
                                );
                            });
                    })
                  }
                >
                  <View
                    ref={(node) => {
                      if (node) cards.current.set(item.id, node);
                      else cards.current.delete(item.id);
                    }}
                  >
                    <RecordCard
                      record={item}
                      props={props}
                      onPress={() => onOpenRecord(item.id)}
                      actions={[
                        ...(recordActions?.(item.id) ?? []),
                        ...columns.map((target) => ({
                          id: `column:${target.key}`,
                          title: `移动到 ${target.label}`,
                          disabled:
                            (item.cells[groupProp.id] ?? UNGROUPED) ===
                            target.key,
                          onPress: () =>
                            onMoveRecord(
                              item.id,
                              target.key === UNGROUPED ? null : target.key,
                            ),
                        })),
                      ]}
                    />
                  </View>
                </DragItem>
              )}
              contentContainerStyle={styles.colContent}
              showsVerticalScrollIndicator={false}
            />
            <Pressable
              onPress={() =>
                onAddRecord(col.key === UNGROUPED ? null : col.key)
              }
              style={({ pressed }) => [
                styles.addBtn,
                pressed && { backgroundColor: tokens.hover },
              ]}
            >
              <Text style={[styles.addText, { color: tokens.muted }]}>
                ＋ 新建
              </Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
      {preview && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: Math.max(0, Math.min(width - 220, preview.x - 110)),
            top: preview.y - 24,
            width: 220,
            padding: 12,
            borderWidth: 1,
            borderColor: tokens.accent,
            borderRadius: 12,
            backgroundColor: tokens.surface,
            zIndex: 100,
          }}
        >
          <Text numberOfLines={2} style={{ color: tokens.fg }}>
            {preview.title}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 24, gap: 12 },
  col: {
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
    maxHeight: "100%",
  },
  colHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 14,
    paddingBottom: 6,
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
  colTitle: { fontSize: fs.sm, fontWeight: "600", flexShrink: 1 },
  colCount: { fontSize: fs.xs, marginLeft: "auto" },
  colContent: { paddingBottom: 4 },
  addBtn: {
    marginHorizontal: 16,
    marginTop: 2,
    paddingVertical: 8,
    borderRadius: radii.md,
    alignItems: "center",
  },
  addText: { fontSize: fs.sm },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  menu: {
    position: "absolute",
    left: 24,
    right: 24,
    top: "28%",
    borderRadius: radii.lg,
    paddingVertical: 6,
    overflow: "hidden",
  },
  menuTitle: {
    fontSize: fs.xs,
    fontWeight: "600",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  menuLabel: { fontSize: fs.ui },
});
