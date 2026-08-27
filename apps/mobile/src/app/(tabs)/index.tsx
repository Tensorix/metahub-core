import { useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AdaptiveFab } from "@/components/AdaptiveFab";
import { EmojiIcon } from "@/components/EmojiIcon";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { useApiData, useLiveInvalidate } from "@/lib/api/hooks";
import type { DbInfo, DocSummaryInfo } from "@/lib/api/sdk";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

interface DocRow {
  kind: "doc";
  doc: DocSummaryInfo;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}
interface DbRow {
  kind: "db";
  db: DbInfo;
}
type Row = DocRow | DbRow;

/** Flatten the parent_id doc tree honoring the expand set. Docs attached to a
 *  database don't belong in the sidebar tree (they surface via their db). */
function flattenDocs(docs: DocSummaryInfo[], expanded: Set<string>): DocRow[] {
  const children = new Map<string | null, DocSummaryInfo[]>();
  for (const d of docs) {
    if (d.database_id) continue;
    const key = d.parent_id;
    const list = children.get(key);
    if (list) list.push(d);
    else children.set(key, [d]);
  }
  const out: DocRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const doc of children.get(parent) ?? []) {
      const kids = children.has(doc.id);
      const open = expanded.has(doc.id);
      out.push({ kind: "doc", doc, depth, hasChildren: kids, expanded: open });
      if (kids && open) walk(doc.id, depth + 1);
    }
  };
  // Orphans (parent synced later than child) fall back to top level.
  const known = new Set(docs.map((d) => d.id));
  for (const [parent, list] of children) {
    if (parent !== null && !known.has(parent)) {
      const top = children.get(null) ?? [];
      children.set(null, top.concat(list));
    }
  }
  walk(null, 0);
  return out;
}

export default function HomeScreen() {
  const router = useRouter();
  const { client } = useSession();
  const { tokens } = useTheme();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchAll = useCallback(
    () => Promise.all([client.listDocuments(), client.listDatabases()]),
    [client],
  );
  const { data, error, loading, refetch } = useApiData(fetchAll);
  const [docs, dbs] = data ?? [null, null];
  useLiveInvalidate(["databases", "documents"], () => void refetch());

  const sections = useMemo(() => {
    const out: { title: string; data: Row[] }[] = [];
    if (docs) out.push({ title: "文档", data: flattenDocs(docs, expanded) });
    if (dbs) out.push({ title: "数据库", data: dbs.map((db) => ({ kind: "db" as const, db })) });
    return out;
  }, [docs, dbs, expanded]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: tokens.bg }]} edges={["top"]}>
      <SectionList
        sections={sections}
        keyExtractor={(row) => (row.kind === "doc" ? row.doc.id : row.db.id)}
        stickySectionHeadersEnabled={false}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl refreshing={loading && data !== null} onRefresh={refetch} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={[styles.title, { color: tokens.fg }]}>Metahub</Text>
            {error ? (
              <ErrorBanner message="加载失败，请检查与服务器的连接" onRetry={refetch} />
            ) : null}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text style={[styles.section, { color: tokens.muted }]}>{section.title}</Text>
        )}
        renderItem={({ item }) =>
          item.kind === "doc" ? (
            <Pressable
              onPress={() => router.push(`/doc/${item.doc.id}`)}
              style={({ pressed }) => [
                styles.row,
                { paddingLeft: 16 + item.depth * 18 },
                pressed && { backgroundColor: tokens.hover },
              ]}
            >
              {item.hasChildren ? (
                <Pressable hitSlop={8} onPress={() => toggle(item.doc.id)}>
                  <Text style={[styles.chevron, { color: tokens.muted }]}>
                    {item.expanded ? "▾" : "▸"}
                  </Text>
                </Pressable>
              ) : (
                <EmojiIcon emoji="📄" size={16} />
              )}
              <Text numberOfLines={1} style={[styles.rowText, { color: tokens.fg }]}>
                {item.doc.title || "未命名"}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => router.push(`/db/${item.db.id}`)}
              style={({ pressed }) => [
                styles.row,
                { paddingLeft: 16 },
                pressed && { backgroundColor: tokens.hover },
              ]}
            >
              <EmojiIcon emoji={item.db.icon || "🗂️"} size={16} />
              <Text numberOfLines={1} style={[styles.rowText, { color: tokens.fg }]}>
                {item.db.name}
              </Text>
            </Pressable>
          )
        }
        ListEmptyComponent={
          loading ? null : (
            <EmptyState title="还没有内容" hint="用右下角按钮新建第一篇文档" />
          )
        }
        contentContainerStyle={styles.listContent}
      />
      <AdaptiveFab
        label="新建文档"
        onPress={async () => {
          const doc = await client.createDocument({ title: "" }).catch(() => null);
          if (doc) router.push(`/doc/${doc.id}`);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  title: { fontSize: 28, fontWeight: "700", letterSpacing: 0.2 },
  section: {
    fontSize: fs.xs,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingRight: 16,
    paddingVertical: 9,
    borderRadius: radii.md,
    marginHorizontal: 6,
  },
  chevron: { fontSize: 13, width: 22, textAlign: "center" },
  rowText: { fontSize: fs.ui, flex: 1 },
  listContent: { paddingBottom: 120 },
});
