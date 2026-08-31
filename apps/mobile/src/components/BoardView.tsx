import { useMemo, useState } from "react";
import {
  Dimensions,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { RecordCard } from "@/components/RecordCard";
import type { PropInfo, RecordInfo } from "@/lib/api/sdk";
import { chipColor, selectOptions } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

const COL_W = Math.min(Dimensions.get("window").width * 0.78, 340);
const UNGROUPED = "__ungrouped__";

interface Column {
  key: string;
  label: string;
  records: RecordInfo[];
}

/** Kanban: one column per option of the grouping select property, horizontal
 *  paging between columns. Mirrors the WebUI board's grouping semantics
 *  (option order from config, ungrouped last). Cross-column move = long-press
 *  a card → column menu (narrow screens make true drag-to-offscreen-column a
 *  poor gesture, and it fights the horizontal scroll). */
export function BoardView({
  records,
  props,
  groupProp,
  onOpenRecord,
  onAddRecord,
  onMoveRecord,
}: {
  records: RecordInfo[];
  props: PropInfo[];
  groupProp: PropInfo;
  onOpenRecord: (id: string) => void;
  onAddRecord: (presetOption: string | null) => void;
  onMoveRecord: (recordId: string, option: string | null) => void;
}) {
  const { tokens, scheme } = useTheme();
  const [moving, setMoving] = useState<RecordInfo | null>(null);

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
    <ScrollView
      horizontal
      snapToInterval={COL_W + 12}
      decelerationRate="fast"
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.strip}
    >
      {columns.map((col) => (
        <View
          key={col.key}
          style={[
            styles.col,
            { width: COL_W, backgroundColor: tokens.sidebar, borderColor: tokens.line },
          ]}
        >
          <View style={styles.colHead}>
            {col.key !== UNGROUPED ? (
              <View
                style={[styles.dot, { backgroundColor: chipColor(col.label, scheme) }]}
              />
            ) : null}
            <Text numberOfLines={1} style={[styles.colTitle, { color: tokens.fgSoft }]}>
              {col.label}
            </Text>
            <Text style={[styles.colCount, { color: tokens.muted }]}>
              {col.records.length}
            </Text>
          </View>
          <FlatList
            data={col.records}
            keyExtractor={(r) => r.id}
            renderItem={({ item }) => (
              <RecordCard
                record={item}
                props={props}
                onPress={() => onOpenRecord(item.id)}
                onLongPress={() => setMoving(item)}
              />
            )}
            contentContainerStyle={styles.colContent}
            showsVerticalScrollIndicator={false}
          />
          <Pressable
            onPress={() => onAddRecord(col.key === UNGROUPED ? null : col.key)}
            style={({ pressed }) => [
              styles.addBtn,
              pressed && { backgroundColor: tokens.hover },
            ]}
          >
            <Text style={[styles.addText, { color: tokens.muted }]}>＋ 新建</Text>
          </Pressable>
        </View>
      ))}
      {moving ? (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => setMoving(null)}
        >
          <Pressable style={styles.scrim} onPress={() => setMoving(null)} />
          <View style={[styles.menu, { backgroundColor: tokens.surface }]}>
            <Text style={[styles.menuTitle, { color: tokens.muted }]} numberOfLines={1}>
              移动到分组
            </Text>
            {columns.map((col) => {
              const cur =
                (typeof moving.cells[groupProp.id] === "string"
                  ? moving.cells[groupProp.id]
                  : null) ?? UNGROUPED;
              const isCur = cur === col.key;
              return (
                <Pressable
                  key={col.key}
                  disabled={isCur}
                  onPress={() => {
                    onMoveRecord(moving.id, col.key === UNGROUPED ? null : col.key);
                    setMoving(null);
                  }}
                  style={({ pressed }) => [
                    styles.menuRow,
                    { borderColor: tokens.line },
                    pressed && { backgroundColor: tokens.hover },
                  ]}
                >
                  {col.key !== UNGROUPED ? (
                    <View
                      style={[
                        styles.dot,
                        { backgroundColor: chipColor(col.label, scheme) },
                      ]}
                    />
                  ) : (
                    <View style={styles.dot} />
                  )}
                  <Text
                    style={[
                      styles.menuLabel,
                      { color: isCur ? tokens.muted : tokens.fg },
                    ]}
                  >
                    {col.label}
                    {isCur ? "（当前）" : ""}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Modal>
      ) : null}
    </ScrollView>
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
