import type { DocRow } from "@/lib/doc-tree";
import { documentPageRows, validPageOffset } from "@/lib/browse/management";
import { Stack, useRouter } from "expo-router";
import { useCallback, useMemo, useEffect, useState } from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { NativeButton } from "@/components/native/NativeButton";
import { createRecentStore } from "@/lib/navigation/recent";
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
  const [page, setPage] = useState({
    workspace: session.workspaceId,
    offset: 0,
  });
  const offset = page.workspace === session.workspaceId ? page.offset : 0;
  const setOffset = (offset: number) =>
    setPage({ workspace: session.workspaceId, offset });
  const [mutationError, setMutationError] = useState<string | null>(null);
  const recentStore = useMemo(
    () => createRecentStore(session.replica.db, session.workspaceId),
    [session.replica.db, session.workspaceId],
  );
  const [recentState, setRecentState] = useState(() => ({
    workspace: session.workspaceId,
    items: recentStore.read(),
  }));
  const recents =
    recentState.workspace === session.workspaceId
      ? recentState.items
      : recentStore.read();
  useEffect(
    () =>
      recentStore.subscribe(() =>
        setRecentState({
          workspace: session.workspaceId,
          items: recentStore.read(),
        }),
      ),
    [recentStore, session.workspaceId],
  );
  const { tokens } = useTheme();
  const recentKey = JSON.stringify(
    recents.map(({ id, kind }) => ({ id, kind })),
  );
  const recentRequests = useMemo(
    () =>
      JSON.parse(recentKey) as {
        id: string;
        kind: "document" | "record" | "database";
      }[],
    [recentKey],
  );
  const fetchRecent = useCallback(async () => {
    const [documents, records, databases] = await Promise.all([
      client.referenceSummaries({
        kind: "document",
        ids: recentRequests
          .filter((r) => r.kind === "document")
          .map((r) => r.id),
      }),
      client.referenceSummaries({
        kind: "record",
        ids: recentRequests.filter((r) => r.kind === "record").map((r) => r.id),
      }),
      client.listDatabases(),
    ]);
    return new Map([
      ...documents.map((r) => [`document:${r.id}`, r] as const),
      ...records.map((r) => [`record:${r.id}`, r] as const),
      ...recentRequests
        .filter((r) => r.kind === "database")
        .map((r) => {
          const db = databases.find((d) => d.id === r.id);
          return [
            `database:${r.id}`,
            { id: r.id, title: db?.name ?? null, missing: !db },
          ] as const;
        }),
    ]);
  }, [client, recentRequests]);
  const recentData = useApiData(fetchRecent);
  useLiveInvalidate(
    ["documents", "records", "databases"],
    () => void recentData.refetch(),
  );

  const fetchAll = useCallback(
    () =>
      Promise.all([
        client.queryDocuments({ offset, limit: 60 }),
        client.listDatabases(),
      ]),
    [client, offset],
  );
  const { data, error, loading, refetch } = useApiData(fetchAll);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await session.syncNow();
      await refetch();
    } catch (e) {
      setMutationError(String(e));
    }
    setRefreshing(false);
  };
  const [docs, dbs] = data ?? [null, null];
  if (docs) {
    const valid = validPageOffset(offset, docs.total, 60);
    if (valid !== offset)
      setPage({ workspace: session.workspaceId, offset: valid });
  }
  useLiveInvalidate(["databases", "documents"], () => void refetch());

  const sections = useMemo(() => {
    const out: { title: string; data: Row[] }[] = [];
    if (docs)
      out.push({ title: "文档", data: documentPageRows(docs.documents) });
    if (dbs)
      out.push({
        title: "数据库",
        data: dbs.map((db) => ({ kind: "db" as const, db })),
      });
    return out;
  }, [docs, dbs]);

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <Stack.Screen options={{ title: "Metahub" }} />
      <Stack.Toolbar placement="right" tintColor={tokens.accent}>
        <Stack.Toolbar.Menu icon={Platform.OS === "ios" ? "plus" : undefined}>
          <Stack.Toolbar.Label>新建</Stack.Toolbar.Label>
          <Stack.Toolbar.MenuAction
            onPress={() =>
              router.push(
                "/manage/document/new?mode=create" as Parameters<
                  typeof router.push
                >[0],
              )
            }
          >
            新建文档
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            onPress={() =>
              router.push(
                "/manage/database/new" as Parameters<typeof router.push>[0],
              )
            }
          >
            新建数据库
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <SectionList
        sections={sections}
        keyExtractor={(row) => (row.kind === "doc" ? row.doc.id : row.db.id)}
        stickySectionHeadersEnabled={false}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
          />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={{ color: tokens.muted }}>{creds.baseUrl}</Text>
            {recents.length ? (
              <View style={{ gap: 4, paddingVertical: 12 }}>
                <Text style={{ color: tokens.muted }}>最近打开</Text>
                {recents.slice(0, 5).map((item) => (
                  <Pressable
                    disabled={
                      recentData.data?.get(`${item.kind}:${item.id}`)?.missing
                    }
                    key={`${item.kind}:${item.id}`}
                    style={{ paddingVertical: 10 }}
                    onPress={() =>
                      router.push(
                        item.kind === "document"
                          ? `/doc/${item.id}`
                          : item.kind === "record"
                            ? `/record/${item.id}`
                            : `/db/${item.id}`,
                      )
                    }
                  >
                    <Text numberOfLines={1} style={{ color: tokens.fg }}>
                      {recentData.data?.get(`${item.kind}:${item.id}`)?.missing
                        ? "目标已删除或不可用"
                        : recentData.data?.get(`${item.kind}:${item.id}`)
                            ?.title ||
                          item.title ||
                          "未命名"}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {mutationError ? <ErrorBanner message={mutationError} /> : null}
            {error ? (
              <ErrorBanner
                message="加载失败，请检查与服务器的连接"
                onRetry={refetch}
              />
            ) : null}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text style={[styles.section, { color: tokens.muted }]}>
            {section.title}
          </Text>
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
                <Pressable
                  hitSlop={8}
                  onPress={() => router.push(`/doc/${item.doc.id}`)}
                >
                  <Text style={[styles.chevron, { color: tokens.muted }]}>
                    {item.expanded ? "▾" : "▸"}
                  </Text>
                </Pressable>
              ) : (
                <EmojiIcon emoji="📄" size={16} />
              )}
              <Text
                numberOfLines={1}
                style={[styles.rowText, { color: tokens.fg }]}
              >
                {item.doc.title || "未命名"}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => {
                recentStore.remember({
                  id: item.db.id,
                  kind: "database",
                  title: item.db.name,
                });
                router.push(`/db/${item.db.id}`);
              }}
              style={({ pressed }) => [
                styles.row,
                { paddingLeft: 16 },
                pressed && { backgroundColor: tokens.hover },
              ]}
            >
              <EmojiIcon emoji={item.db.icon || "🗂️"} size={16} />
              <Text
                numberOfLines={1}
                style={[styles.rowText, { color: tokens.fg }]}
              >
                {item.db.name}
              </Text>
            </Pressable>
          )
        }
        ListEmptyComponent={
          loading || error ? null : (
            <EmptyState title="还没有内容" hint="点按新建，开始第一篇文档" />
          )
        }
        ListFooterComponent={
          <View style={{ gap: 8, padding: 16 }}>
            {loading ? (
              <Text style={{ color: tokens.muted }}>加载中…</Text>
            ) : null}
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <NativeButton
                disabled={!offset || loading}
                onPress={() => setOffset(Math.max(0, offset - 60))}
              >
                上一页
              </NativeButton>
              <Text style={{ color: tokens.muted }}>
                文档 {docs?.total ?? 0} · 第 {Math.floor(offset / 60) + 1} 页
              </Text>
              <NativeButton
                disabled={!docs?.hasMore || loading}
                onPress={() => setOffset(offset + 60)}
              >
                下一页
              </NativeButton>
            </View>
          </View>
        }
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: Platform.OS === "android" ? 88 : 20 },
        ]}
      />
      <AdaptiveFab
        label="新建文档"
        bottomInsetConsumed
        onPress={() =>
          router.push(
            "/manage/document/new?mode=create" as Parameters<
              typeof router.push
            >[0],
          )
        }
      />
    </View>
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
  listContent: { paddingBottom: 88 },
});
