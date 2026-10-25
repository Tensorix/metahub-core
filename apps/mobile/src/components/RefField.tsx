import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  TextInput,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useApiData } from "@/lib/api/hooks";
import type { PropInfo } from "@/lib/api/sdk";
import { useSession } from "@/lib/auth/session";
import { recordTitle } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

export interface Candidate {
  id: string;
  title: string;
}

/** id → title candidate sets for every relation/doc property of a record, in
 *  one fetch pass. Kept outside the SwiftUI <Host> (RN views can't nest in
 *  it) — the form renders plain text from these, the picker lives in a Modal. */
export function useRefData(props: PropInfo[]): {
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  candidates: (prop: PropInfo) => Candidate[];
  titleOf: (prop: PropInfo, id: string) => string;
  refDisplay: (prop: PropInfo, value: unknown) => string;
} {
  const { client } = useSession();
  const refProps = useMemo(
    () => props.filter((p) => p.type === "relation" || p.type === "doc"),
    [props],
  );
  const key = refProps.map((p) => `${p.id}:${p.config?.database ?? ""}`).join(",");

  const fetchAll = useCallback(async () => {
    const out = new Map<string, Candidate[]>();
    const needsDocs = refProps.some((p) => p.type === "doc");
    const docListP = needsDocs ? client.queryDocuments({limit:60}) : null;
    await Promise.all(
      refProps.map(async (p) => {
        if (p.type === "relation") {
          const target = p.config?.database as string | undefined;
          if (!target) {
            out.set(p.id, []);
            return;
          }
          const [records, targetProps] = await Promise.all([
            client.queryRecords(target, { limit: 60 }),
            client.listProperties(target),
          ]);
          out.set(
            p.id,
            records.records.map((r) => ({ id: r.id, title: recordTitle(r, targetProps) })),
          );
        } else {
          const docs = await docListP!;
          out.set(
            p.id,
            docs.documents.map((d) => ({ id: d.id, title: d.title || "未命名" })),
          );
        }
      }),
    );
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  const { data, loading, error, refetch } = useApiData(fetchAll);

  const candidates = useCallback(
    (prop: PropInfo) => data?.get(prop.id) ?? [],
    [data],
  );
  const titleOf = useCallback(
    (prop: PropInfo, id: string) =>
      data?.get(prop.id)?.find((c) => c.id === id)?.title ?? `${id.slice(0, 12)}…`,
    [data],
  );
  const refDisplay = useCallback(
    (prop: PropInfo, value: unknown) => {
      const ids = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string")
        : [];
      if (!ids.length) return "（点按选择）";
      return ids.map((id) => titleOf(prop, id)).join("、");
    },
    [titleOf],
  );

  return { candidates, titleOf, refDisplay, loading, error, refetch };
}

/** Multi-select picker over a relation/doc target set (RN modal sheet).
 *  Selection is optimistic local state (seeded on mount) so rapid toggles
 *  never rebuild from a stale server snapshot. */
export function RefPickerSheet({
  prop,
  candidates,
  initialSelected,
  onChange,
  onClose,
  loading = false,
  error,
  onRetry,
}: {
  prop: PropInfo;
  candidates: Candidate[];
  initialSelected: string[];
  onChange: (next: string[]) => void;
  onClose: () => void;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
}) {
  const { tokens } = useTheme();
  const { client } = useSession();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(initialSelected);
  const latest = useRef(selected);
  const [query, setQuery] = useState("");
  const target = prop.type === "relation" ? (prop.config?.database as string) : "docs";

  const fetchPage = useCallback(async () => {
    if (prop.type === "doc") { const result = await client.queryDocuments({search:query,offset,limit:60}); return {...result,candidates:result.documents.map(doc => ({id:doc.id,title:doc.title || "未命名"}))}; }
    if (!target) return null;
    const [result, props] = await Promise.all([client.queryRecords(target, {search: query, offset, limit: 60}), client.listProperties(target)]);
    return {...result, candidates: result.records.map(record => ({id: record.id, title: recordTitle(record, props)}))};
  }, [client, prop.type, target, query, offset]);
  const page = useApiData(fetchPage);
  const choices = page.data?.candidates ?? (!query && !offset ? candidates : []);
  const pageLoading = page.loading || loading;
  const pageError = page.error ?? error;

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...new Set([...latest.current, id])] : latest.current.filter((s) => s !== id);
    latest.current = next;
    setSelected(next);
    onChange(next);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: tokens.surface }]}>
        <View style={[styles.grabber, { backgroundColor: tokens.lineStrong }]} />
        <View style={styles.head}>
          <Text style={[styles.title, { color: tokens.fg }]}>{prop.name}</Text>
          <Pressable hitSlop={10} onPress={onClose}>
            <Text style={{ color: tokens.accent, fontSize: fs.ui }}>完成</Text>
          </Pressable>
        </View>
        <TextInput accessibilityLabel="搜索关联项" placeholder="搜索关联项" value={query} onChangeText={value => { setQuery(value); setOffset(0); }} style={{ padding: 16, color: tokens.fg }} />
        {pageLoading ? <ActivityIndicator color={tokens.accent} /> : null}
        {pageError ? <Pressable onPress={() => { void page.refetch(); onRetry?.(); }}><Text style={[styles.empty, { color: tokens.danger }]}>加载失败，点按重试</Text></Pressable> : null}
        {<View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16 }}>
          <Pressable disabled={!offset || pageLoading} style={{padding:12}} onPress={() => setOffset(Math.max(0, offset - 60))}><Text style={{color:tokens.accent}}>上一页</Text></Pressable>
          <Text style={{color:tokens.muted, padding:12}}>{page.data?.total ?? 0} 项</Text>
          <Pressable disabled={!page.data?.hasMore || pageLoading} style={{padding:12}} onPress={() => setOffset(offset + 60)}><Text style={{color:tokens.accent}}>下一页</Text></Pressable>
        </View>}
        <FlatList
          data={choices}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => {
            const on = selected.includes(item.id);
            return (
              <Pressable
                onPress={() => toggle(item.id, !on)}
                style={({ pressed }) => [
                  styles.candRow,
                  { borderColor: tokens.line },
                  pressed && { backgroundColor: tokens.hover },
                ]}
              >
                <Text numberOfLines={1} style={[styles.candTitle, { color: tokens.fg }]}>
                  {item.title}
                </Text>
                {on ? (
                  <Text style={{ color: tokens.accent, fontSize: fs.body }}>✓</Text>
                ) : null}
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: tokens.muted }]}>
              {pageLoading ? "正在加载…" : pageError ? "暂时无法加载选项" : !target ? "该关联列未配置目标数据库" : query ? "没有匹配项" : "没有可选项"}
            </Text>
          }
          contentContainerStyle={styles.listContent}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: {
    height: "60%",
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
  title: { fontSize: fs.body, fontWeight: "600" },
  candRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  candTitle: { fontSize: fs.ui, flexShrink: 1 },
  empty: { textAlign: "center", paddingVertical: 24, fontSize: fs.sm },
  listContent: { paddingBottom: 32 },
});
