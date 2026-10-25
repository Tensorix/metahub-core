import { flattenDocs, type DocRow } from "@/lib/doc-tree";
import { useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Modal,
  TextInput,
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
import type { DbInfo } from "@/lib/api/sdk";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

interface DbRow {
  kind: "db";
  db: DbInfo;
}
type Row = DocRow | DbRow;

export default function HomeScreen() {
  const router = useRouter();
  const session = useSession();
  const { client, creds } = session;
  const [newDatabase, setNewDatabase] = useState(false);
  const [databaseName, setDatabaseName] = useState("");
  const pending = useRef(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { tokens } = useTheme();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchAll = useCallback(
    () => Promise.all([client.listDocuments(), client.listDatabases()]),
    [client],
  );
  const { data, error, loading, refetch } = useApiData(fetchAll);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try { await session.syncNow(); await refetch(); } catch (e) { setMutationError(String(e)); }
    setRefreshing(false);
  };
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
          <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={[styles.title, { color: tokens.fg }]}>Metahub</Text>
            <Text style={{ color: tokens.muted }}>{creds.baseUrl}</Text>
            <Pressable accessibilityRole="button" onPress={() => setNewDatabase(true)} style={{ paddingVertical: 14 }}><Text style={{ color: tokens.accent }}>新建数据库</Text></Pressable>
            {mutationError ? <ErrorBanner message={mutationError} /> : null}
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
      <Modal visible={newDatabase} transparent animationType="fade" onRequestClose={() => setNewDatabase(false)}>
        <View style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.35)" }}>
          <View style={{ padding: 24, backgroundColor: tokens.surface, borderRadius: 16 }}>
            <Text style={{ color: tokens.fg, fontSize: 20 }}>新建数据库</Text>
            <TextInput accessibilityLabel="数据库名称" placeholder="数据库名称" placeholderTextColor={tokens.muted} value={databaseName} onChangeText={setDatabaseName} style={{ paddingVertical: 20, color: tokens.fg }} />
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 20 }}>
              <Pressable style={{ padding: 12 }} onPress={() => setNewDatabase(false)}><Text style={{ color: tokens.accent }}>取消</Text></Pressable>
              <Pressable disabled={creating || !databaseName.trim()} style={{ padding: 12 }} onPress={() => { if (pending.current) return; pending.current = true; setCreating(true); void client.createDatabase({ name: databaseName.trim() }).then(async db => { if (!session.isCurrent()) return; await client.createProperty({db: db.id, name: "名称", type: "text"}); if (session.isCurrent()) { setNewDatabase(false); setDatabaseName(""); router.push(`/db/${db.id}`); } }).catch(e => { setMutationError(String(e)); setNewDatabase(false); }).finally(() => { pending.current = false; setCreating(false); }); }}><Text style={{ color: tokens.accent }}>{creating ? "创建中…" : "创建"}</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <AdaptiveFab
        label={creating ? "创建中…" : "新建文档"}
        onPress={async () => {
          if (pending.current) return;
          pending.current = true; setCreating(true); setMutationError(null);
          try { const doc = await client.createDocument({ title: "" }); if (session.isCurrent()) router.push(`/doc/${doc.id}`); }
          catch { setMutationError("创建文档失败，请重试"); }
          finally { pending.current = false; setCreating(false); }
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
