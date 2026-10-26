import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { NativeHost } from "@/components/native/NativeHost";
import { NativeButton } from "@/components/native/NativeButton";
import { RecordTextInput } from "@/components/RecordTextInput";
import { ErrorBanner } from "@/components/ErrorBanner";
import { scheduleSearch } from "@/lib/api/request-state";
import { useApiData, useLiveInvalidate } from "@/lib/api/hooks";
import { EmptyState } from "@/components/EmptyState";
import type { SearchHitInfo } from "@/lib/api/sdk";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { fs, radii } from "@/lib/theme/tokens";

export default function SearchScreen() {
  const router = useRouter();
  const { client, workspaceId } = useSession();
  const { tokens } = useTheme();
  const [q, setQ] = useState("");
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
  const onQuery = (text: string) => {
    setQ(text);
    setPage({ key: `${workspaceId}:${text.trim()}`, offset: 0 });
  };

  const open = (hit: SearchHitInfo) => {
    if (hit.type === "document") router.push(`/doc/${hit.id}`);
    else if (hit.database_id) router.push(`/record/${hit.id}`);
  };

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: tokens.bg }]}
      edges={["top"]}
    >
      <View style={styles.searchWrap}>
        <NativeHost matchContents style={{ minHeight: 44 }}>
          <RecordTextInput
            text={q}
            onChangeText={onQuery}
            placeholder="搜索文档与记录"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={{ padding: 12 }}
          />
        </NativeHost>
      </View>
      {error && q === debounced ? (
        <ErrorBanner message="搜索失败，请重试" onRetry={refetch} />
      ) : null}
      {(loading || q !== debounced) && q.trim() ? (
        <Text style={{ color: tokens.muted }}>搜索中…</Text>
      ) : null}
      <FlatList
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
          !loading && q === debounced && !error && hits !== null && q.trim() ? (
            <EmptyState title="没有匹配结果" />
          ) : null
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
          ) : null
        }
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.listContent}
      />
    </SafeAreaView>
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
