import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import { NativeButton } from "@/components/native/NativeButton";

import { ErrorBanner } from "@/components/ErrorBanner";
import { scheduleSearch } from "@/lib/api/request-state";
import { useApiData, useLiveInvalidate } from "@/lib/api/hooks";
import { EmptyState } from "@/components/EmptyState";
import type { SearchHitInfo } from "@/lib/api/sdk";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

export function SearchResults({ query }: { query: string }) {
  const router = useRouter();
  const { client, workspaceId } = useSession();
  const { tokens } = useTheme();
  const q = query;
  const [page, setPage] = useState({ key: "", offset: 0 });
  const pageKey = `${workspaceId}:${q.trim()}`;
  const offset = page.key === pageKey ? page.offset : 0;
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    return scheduleSearch(() => setDebounced(q));
  }, [q]);
  const fetchSearch = useCallback(async () => {
    const text = debounced.trim();
    if (!text) return null;
    return client.querySearch(text, { offset, limit: 60 });
  }, [debounced, client, offset]);
  const { data: hits, error, loading, refetch } = useApiData(fetchSearch);
  useLiveInvalidate(["documents", "records"], () => void refetch());

  const open = (hit: SearchHitInfo) => {
    if (hit.type === "document") router.push(`/doc/${hit.id}`);
    else if (hit.database_id) router.push(`/record/${hit.id}`);
  };

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: tokens.bg }}
      ListHeaderComponent={
        <>
          {error && q === debounced ? (
            <ErrorBanner message="搜索失败，请重试" onRetry={refetch} />
          ) : null}
          {(loading || q !== debounced) && q.trim() ? (
            <Text style={{ color: tokens.muted }}>搜索中…</Text>
          ) : null}
        </>
      }
      data={q === debounced ? (hits?.hits ?? []) : []}
      keyExtractor={(h) => `${h.type}:${h.id}`}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item }) => (
        <Pressable
          onPress={() => open(item)}
          style={({ pressed }) => [
            styles.hit,
            pressed && { backgroundColor: tokens.hover },
          ]}
        >
          <Text
            numberOfLines={1}
            style={[styles.hitTitle, { color: tokens.fg }]}
          >
            {item.title || "未命名"}
          </Text>
          {item.snippet ? (
            <Text
              numberOfLines={2}
              style={[styles.hitSnippet, { color: tokens.muted }]}
            >
              {item.snippet}
            </Text>
          ) : null}
        </Pressable>
      )}
      ListEmptyComponent={
        !q.trim() ? (
          <EmptyState
            title="搜索你的资料"
            hint="输入关键词，查找文档正文和数据表记录"
          />
        ) : !loading && q === debounced && !error && hits !== undefined ? (
          <EmptyState title="没有匹配结果" hint="试试更短的关键词" />
        ) : undefined
      }
      ListFooterComponent={
        q.trim() && q === debounced ? (
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              padding: 12,
            }}
          >
            <NativeButton
              disabled={!offset || loading}
              onPress={() =>
                setPage({ key: pageKey, offset: Math.max(0, offset - 60) })
              }
            >
              上一页
            </NativeButton>
            <Text style={{ color: tokens.muted }}>
              第 {Math.floor(offset / 60) + 1} 页
            </Text>
            <NativeButton
              disabled={!hits?.hasMore || loading}
              onPress={() => setPage({ key: pageKey, offset: offset + 60 })}
            >
              下一页
            </NativeButton>
          </View>
        ) : undefined
      }
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.listContent}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchWrap: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  input: {
    height: 42,
    borderRadius: radii.lg,
    paddingHorizontal: 14,
    fontSize: fs.body,
  },
  hit: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 2,
    borderRadius: radii.md,
    marginHorizontal: 6,
  },
  hitTitle: { fontSize: fs.ui, fontWeight: "500" },
  hitSnippet: { fontSize: fs.sm, lineHeight: 18 },
  listContent: { paddingBottom: 20 },
});
