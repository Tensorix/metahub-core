import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useApiData } from "@/lib/api/hooks";
import type { RecordRevision, RecordVersionState } from "@/lib/api/mobile-api";
import type { PropInfo } from "@/lib/api/sdk";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

function formatAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `今天 ${hm}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return sameYear ? `${md} ${hm}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function revisionLabel(rev: RecordRevision): string {
  if (rev.created) return "创建";
  if (rev.deleted) return "删除";
  return `改动 ${rev.changes} 项`;
}

/** Record version history: revision list → tap to preview that version's
 *  cells → restore (recorded as a new forward revision, server-side). */
export function HistorySheet({
  visible,
  onClose,
  recordId,
  props,
  onReverted,
}: {
  visible: boolean;
  onClose: () => void;
  recordId: string;
  props: PropInfo[];
  onReverted: () => void;
}) {
  const { api } = useSession();
  const { tokens } = useTheme();
  const [preview, setPreview] = useState<RecordVersionState | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchHistory = useCallback(
    () => (visible ? api.recordHistory(recordId) : Promise.resolve([])),
    [api, recordId, visible],
  );
  const { data: revisions, loading } = useApiData(fetchHistory);

  const openPreview = async (rev: RecordRevision) => {
    setBusy(true);
    const state = await api.recordAt(recordId, rev.version).catch(() => null);
    setBusy(false);
    if (state) setPreview(state);
  };

  const restore = (state: RecordVersionState) => {
    Alert.alert("恢复此版本", "当前值会被该版本覆盖（以新版本记录，可再次恢复）。", [
      { text: "取消", style: "cancel" },
      {
        text: "恢复",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          const r = await api.revertRecord(recordId, state.version).catch(() => null);
          setBusy(false);
          if (r) {
            setPreview(null);
            onReverted();
            onClose();
          } else {
            Alert.alert("恢复失败", "请稍后重试");
          }
        },
      },
    ]);
  };

  const propName = (pid: string) => props.find((p) => p.id === pid)?.name ?? pid;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: tokens.surface }]}>
        <View style={[styles.grabber, { backgroundColor: tokens.lineStrong }]} />
        {preview ? (
          <>
            <View style={styles.head}>
              <Pressable hitSlop={10} onPress={() => setPreview(null)}>
                <Text style={{ color: tokens.accent, fontSize: fs.ui }}>‹ 返回</Text>
              </Pressable>
              <Text style={[styles.title, { color: tokens.fg }]}>版本预览</Text>
              <Pressable hitSlop={10} onPress={() => restore(preview)} disabled={busy}>
                <Text style={{ color: tokens.danger, fontSize: fs.ui }}>恢复</Text>
              </Pressable>
            </View>
            <FlatList
              data={Object.entries(preview.data)}
              keyExtractor={([pid]) => pid}
              renderItem={({ item: [pid, value] }) => (
                <View style={[styles.cellRow, { borderColor: tokens.line }]}>
                  <Text style={[styles.cellName, { color: tokens.muted }]}>
                    {propName(pid)}
                  </Text>
                  <Text style={[styles.cellValue, { color: tokens.fg }]} numberOfLines={3}>
                    {value == null || value === ""
                      ? "（空）"
                      : Array.isArray(value)
                        ? value.join("、")
                        : String(value)}
                  </Text>
                </View>
              )}
              ListEmptyComponent={
                <Text style={[styles.empty, { color: tokens.muted }]}>
                  该版本没有任何字段值
                </Text>
              }
              contentContainerStyle={styles.listContent}
            />
          </>
        ) : (
          <>
            <View style={styles.head}>
              <View style={styles.headSide} />
              <Text style={[styles.title, { color: tokens.fg }]}>版本历史</Text>
              <Pressable hitSlop={10} onPress={onClose} style={styles.headSide}>
                <Text style={{ color: tokens.accent, fontSize: fs.ui, textAlign: "right" }}>
                  完成
                </Text>
              </Pressable>
            </View>
            {loading || busy ? <ActivityIndicator color={tokens.accent} /> : null}
            <FlatList
              data={revisions ?? []}
              keyExtractor={(rev) => rev.version}
              renderItem={({ item: rev }) => (
                <Pressable
                  onPress={() => void openPreview(rev)}
                  style={({ pressed }) => [
                    styles.revRow,
                    { borderColor: tokens.line },
                    pressed && { backgroundColor: tokens.hover },
                  ]}
                >
                  <View style={styles.revMain}>
                    <Text style={[styles.revLabel, { color: tokens.fg }]}>
                      {revisionLabel(rev)}
                      {rev.fields.length
                        ? `：${rev.fields.map(propName).slice(0, 3).join("、")}${rev.fields.length > 3 ? "…" : ""}`
                        : ""}
                    </Text>
                    <Text style={[styles.revMeta, { color: tokens.muted }]}>
                      {formatAt(rev.at)}
                      {rev.actor ? ` · ${rev.actor}` : ""}
                    </Text>
                  </View>
                  <Text style={{ color: tokens.muted, fontSize: fs.ui }}>›</Text>
                </Pressable>
              )}
              ListEmptyComponent={
                loading ? null : (
                  <Text style={[styles.empty, { color: tokens.muted }]}>暂无历史</Text>
                )
              }
              contentContainerStyle={styles.listContent}
            />
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: {
    height: "72%",
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingTop: 8,
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 8,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  headSide: { width: 56 },
  title: { fontSize: fs.body, fontWeight: "600" },
  revRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  revMain: { flex: 1, gap: 2 },
  revLabel: { fontSize: fs.ui },
  revMeta: { fontSize: fs.sm },
  cellRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cellName: { fontSize: fs.sm },
  cellValue: { fontSize: fs.ui },
  empty: { textAlign: "center", paddingVertical: 24, fontSize: fs.sm },
  listContent: { paddingBottom: 32 },
});
