import { useRouter } from "expo-router";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { FlatList, Text, View } from "react-native";

import {
  SearchLoading,
  SearchRetry,
  SearchPlaceholder,
  SearchResultRow,
} from "./native/SearchPresentation";

import { ErrorBanner } from "@/components/ErrorBanner";
import { scheduleSearch } from "@/lib/api/request-state";
import { useLiveInvalidate } from "@/lib/api/hooks";
import type { SearchHitInfo } from "@/lib/api/sdk";
import { useSession } from "@/lib/auth/session";
import { createSearchFeed } from "@/lib/api/search-feed";
import { useTheme } from "@/lib/theme";

export function SearchResults({ query }: { query: string }) {
  const router = useRouter();
  const { client, workspaceId } = useSession();
  const { tokens } = useTheme();
  const q = query.trim();
  const queryKey = `${workspaceId}:${q}`;
  const feed = useMemo(
    () => ({
      key: queryKey,
      ...createSearchFeed((offset) =>
        client.querySearch(q, { offset, limit: 60 }),
      ),
    }),
    [client, q, queryKey],
  );
  const { hits, hasMore, loading, loadingMore, error, moreError } =
    useSyncExternalStore(feed.subscribe, feed.snapshot);
  useEffect(() => {
    feed.activate();
    const cancel = q ? scheduleSearch(() => void feed.reload()) : () => {};
    return () => {
      cancel();
      feed.dispose();
    };
  }, [feed, q]);
  useLiveInvalidate(["documents", "records"], () => {
    if (q) void feed.reload();
  });

  const open = (hit: SearchHitInfo) => {
    if (hit.type === "document") router.push(`/doc/${hit.id}`);
    else if (hit.database_id) router.push(`/record/${hit.id}`);
  };

  return (
    <FlatList
      key={feed.key}
      style={{ flex: 1, backgroundColor: tokens.bg }}
      ListHeaderComponent={
        <>
          {error && q ? (
            <ErrorBanner message="搜索失败，请重试" onRetry={feed.reload} />
          ) : null}
          {loading && q ? <SearchLoading /> : null}
          {q && !loading && !error && hits.length > 0 && (
            <View
              style={{
                paddingHorizontal: 20,
                paddingTop: 12,
                paddingBottom: 8,
              }}
            >
              <Text
                accessibilityRole="header"
                style={{ color: tokens.fgSoft, fontSize: 13 }}
              >
                {`${hits.length}${hasMore ? "+" : ""} 项结果`}
              </Text>
            </View>
          )}
        </>
      }
      data={q ? hits : []}
      onEndReached={() => {
        if (q && !moreError) void feed.loadMore();
      }}
      onEndReachedThreshold={0.5}
      keyExtractor={(h) => `${h.type}:${h.id}`}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      ItemSeparatorComponent={() => (
        <View
          style={{
            height: 0.5,
            backgroundColor: tokens.line,
            marginLeft: 62,
            marginRight: 20,
          }}
        />
      )}
      renderItem={({ item }) => (
        <SearchResultRow hit={item} onPress={() => open(item)} />
      )}
      ListEmptyComponent={
        !q.trim() ? (
          <SearchPlaceholder />
        ) : !loading && !error ? (
          <SearchPlaceholder searching />
        ) : undefined
      }
      ListFooterComponent={
        q && hits.length > 0 ? (
          loadingMore ? (
            <SearchLoading />
          ) : moreError ? (
            <SearchRetry onPress={() => void feed.loadMore()} />
          ) : !hasMore ? (
            <Text
              style={{
                color: tokens.fgSoft,
                textAlign: "center",
                padding: 24,
                fontSize: 13,
              }}
            >
              已显示全部 {hits.length} 项结果
            </Text>
          ) : undefined
        ) : undefined
      }
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: 32 }}
    />
  );
}
