import { FlashList } from "@shopify/flash-list";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";

import { AdaptiveFab } from "@/components/AdaptiveFab";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { RecordCard } from "@/components/RecordCard";
import { SortSheet, type SortSpec } from "@/components/SortSheet";
import { useApiData, useLiveInvalidate } from "@/lib/api/hooks";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { fs } from "@/lib/theme/tokens";

export default function DatabaseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { client } = useSession();
  const { tokens } = useTheme();
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [sortOpen, setSortOpen] = useState(false);

  const fetchDb = useCallback(async () => {
    const [dbs, props, records] = await Promise.all([
      client.listDatabases(),
      client.listProperties(id),
      // Sort by property id — names are ambiguous under duplicate columns.
      client.listRecords(id, {
        limit: 500,
        ...(sort ? { sort: `${sort.dir === "desc" ? "-" : ""}${sort.propId}` } : {}),
      }),
    ]);
    return { db: dbs.find((d) => d.id === id) ?? null, props, records };
  }, [client, id, sort]);

  const { data, error, loading, refetch } = useApiData(fetchDb);
  useLiveInvalidate(["records", "properties", "databases"], () => void refetch());

  const props = useMemo(
    () => (data?.props ?? []).slice().sort((a, b) => a.position - b.position),
    [data?.props],
  );

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <Stack.Screen
        options={{
          title: data?.db ? `${data.db.icon ?? ""} ${data.db.name}`.trim() : "数据库",
          headerRight: () => (
            <Pressable hitSlop={10} onPress={() => setSortOpen(true)}>
              <Text style={{ color: tokens.accent, fontSize: fs.ui }}>
                {sort ? `排序:${sort.name}` : "排序"}
              </Text>
            </Pressable>
          ),
        }}
      />
      {error ? (
        <ErrorBanner message="加载失败，请检查与服务器的连接" onRetry={refetch} />
      ) : null}
      <FlashList
        data={data?.records ?? []}
        keyExtractor={(r) => r.id}
        refreshControl={
          <RefreshControl refreshing={loading && data !== null} onRefresh={refetch} />
        }
        renderItem={({ item }) => (
          <RecordCard
            record={item}
            props={props}
            onPress={() => router.push(`/record/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          loading ? null : <EmptyState title="还没有记录" hint="用右下角按钮新建一条" />
        }
        contentContainerStyle={styles.listContent}
      />
      <SortSheet
        isPresented={sortOpen}
        onDismiss={() => setSortOpen(false)}
        props={props}
        sort={sort}
        onChange={setSort}
      />
      <AdaptiveFab
        label="新建记录"
        onPress={async () => {
          const rec = await client.createRecord(id, {}).catch(() => null);
          if (rec && "id" in rec) router.push(`/record/${rec.id}`);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  listContent: { paddingTop: 8, paddingBottom: 120 },
});
