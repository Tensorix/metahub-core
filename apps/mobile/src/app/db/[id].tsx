import { FlashList } from "@shopify/flash-list";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";

import { AdaptiveFab } from "@/components/AdaptiveFab";
import { BoardView } from "@/components/BoardView";
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
  const [view, setView] = useState<"list" | "board">("list");

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
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };
  useLiveInvalidate(["records", "properties", "databases"], () => void refetch());

  const props = useMemo(
    () => (data?.props ?? []).slice().sort((a, b) => a.position - b.position),
    [data?.props],
  );
  // Board groups by the first select property (mirrors the WebUI default).
  const groupProp = useMemo(() => props.find((p) => p.type === "select") ?? null, [props]);

  const addRecord = useCallback(
    async (presetOption: string | null) => {
      const values =
        presetOption && groupProp ? { [groupProp.id]: presetOption } : {};
      const rec = await client.createRecord(id, values).catch(() => null);
      if (rec && "id" in rec) router.push(`/record/${rec.id}`);
    },
    [client, id, groupProp, router],
  );

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <Stack.Screen
        options={{
          title: data?.db ? `${data.db.icon ?? ""} ${data.db.name}`.trim() : "数据库",
          headerRight: () => (
            <View style={styles.headerRight}>
              {groupProp ? (
                <Pressable
                  hitSlop={10}
                  onPress={() => setView((v) => (v === "list" ? "board" : "list"))}
                >
                  <Text style={{ color: tokens.accent, fontSize: fs.ui }}>
                    {view === "list" ? "看板" : "列表"}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable hitSlop={10} onPress={() => setSortOpen(true)}>
                <Text style={{ color: tokens.accent, fontSize: fs.ui }}>
                  {sort ? `排序:${sort.name}` : "排序"}
                </Text>
              </Pressable>
            </View>
          ),
        }}
      />
      {error ? (
        <ErrorBanner message="加载失败，请检查与服务器的连接" onRetry={refetch} />
      ) : null}
      {view === "board" && groupProp ? (
        <BoardView
          records={data?.records ?? []}
          props={props}
          groupProp={groupProp}
          onOpenRecord={(rid) => router.push(`/record/${rid}`)}
          onAddRecord={(preset) => void addRecord(preset)}
          onMoveRecord={(rid, option) => {
            if (!groupProp) return;
            void client
              .updateRecord(rid, { [groupProp.id]: option ?? null })
              .then(() => refetch())
              .catch(() => {});
          }}
        />
      ) : (
        <FlashList
          data={data?.records ?? []}
          keyExtractor={(r) => r.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />
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
      )}
      <SortSheet
        isPresented={sortOpen}
        onDismiss={() => setSortOpen(false)}
        props={props}
        sort={sort}
        onChange={setSort}
      />
      <AdaptiveFab label="新建记录" onPress={() => void addRecord(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  listContent: { paddingTop: 8, paddingBottom: 120 },
  headerRight: { flexDirection: "row", gap: 18 },
});
