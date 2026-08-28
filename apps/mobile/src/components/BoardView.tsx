import { useMemo } from "react";
import {
  Dimensions,
  FlatList,
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
 *  (option order from config, ungrouped last). Card drag between columns is
 *  a follow-up — tap a card and switch its select in the form instead. */
export function BoardView({
  records,
  props,
  groupProp,
  onOpenRecord,
  onAddRecord,
}: {
  records: RecordInfo[];
  props: PropInfo[];
  groupProp: PropInfo;
  onOpenRecord: (id: string) => void;
  onAddRecord: (presetOption: string | null) => void;
}) {
  const { tokens, scheme } = useTheme();

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
});
