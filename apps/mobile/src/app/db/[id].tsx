import { FlashList } from "@shopify/flash-list";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { MaterialFab } from "@/components/native/MaterialFab";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BoardView } from "@/components/BoardView";
import { NativeButton } from "@/components/native/NativeButton";
import { NativeHost } from "@/components/native/NativeHost";
import { RecordTextInput } from "@/components/RecordTextInput";
import { RecordOrderSheet } from "@/components/RecordOrderSheet";
import {
  adjacentAnchor,
  manualOrderAllowed,
  findManualNeighbor,
  validPageOffset,
} from "@/lib/browse/management";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { RecordCard } from "@/components/RecordCard";
import { useApiData, useLiveInvalidate } from "@/lib/api/hooks";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { normalizeViews } from "../../../../../src/shared/views/model.ts";
const PAGE = 60;

export default function DatabaseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter(),
    session = useSession(),
    { client, replica, workspaceId } = session;
  const { tokens } = useTheme();
  const insets = useSafeAreaInsets();
  const pending = useRef(false);
  const [mutationError, setMutationError] = useState<string | null>(null),
    [creating, setCreating] = useState(false);
  const [ordering, setOrdering] = useState<string | null>(null);
  const [query, setQuery] = useState(""),
    [page, setPage] = useState({ key: "", offset: 0 });
  const key = `${workspaceId}:${id}`;
  const savedPreference = useMemo(() => {
    replica.db.exec(
      "CREATE TABLE IF NOT EXISTS mobile_view_preferences (key TEXT PRIMARY KEY, view_id TEXT NOT NULL)",
    );
    return (
      replica.db
        .query("SELECT view_id FROM mobile_view_preferences WHERE key = ?")
        .get(key) as { view_id: string } | null
    )?.view_id;
  }, [replica.db, key]);
  const [selection, setSelection] = useState<{
    key: string;
    id: string;
  } | null>(null);
  const preferred = selection?.key === key ? selection.id : savedPreference;
  const fetchMetadata = useCallback(async () => {
    const [dbs, props] = await Promise.all([
      client.listDatabases(),
      client.listProperties(id),
    ]);
    return { db: dbs.find((d) => d.id === id) ?? null, props };
  }, [client, id]);
  const meta = useApiData(fetchMetadata);
  const views = useMemo(
    () => normalizeViews(meta.data?.db?.meta?.views),
    [meta.data?.db?.meta?.views],
  );
  const active = views.find((v) => v.id === preferred) ?? views[0]!;
  const props = useMemo(
    () =>
      (meta.data?.props ?? []).slice().sort((a, b) => a.position - b.position),
    [meta.data?.props],
  );
  const visible = useMemo(
    () => props.filter((p) => !active.hidden.includes(p.id)),
    [props, active.hidden],
  );
  const pageKey = `${key}:${active.id}:${JSON.stringify(active.filter)}:${JSON.stringify(active.sort)}:${query}`;
  const offset = page.key === pageKey ? page.offset : 0;
  const fetchRecords = useCallback(
    async () =>
      client.queryRecords(id, {
        search: query,
        filter: active.filter,
        sort: active.sort,
        offset,
        limit: PAGE,
      }),
    [client, id, query, active.filter, active.sort, offset],
  );
  const rows = useApiData(fetchRecords);
  if (rows.data) {
    const valid = validPageOffset(offset, rows.data.total, PAGE);
    if (valid !== offset) setPage({ key: pageKey, offset: valid });
  }
  const { refetch: refetchMeta } = meta,
    { refetch: refetchRows } = rows;
  const refetch = useCallback(async () => {
    await Promise.all([refetchMeta(), refetchRows()]);
  }, [refetchMeta, refetchRows]);
  useLiveInvalidate(
    ["records", "properties", "databases"],
    () => void refetch(),
  );
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await session.syncNow();
      await refetch();
    } catch (e) {
      setMutationError(String(e));
    } finally {
      setRefreshing(false);
    }
  };
  const choose = (viewId: string) => {
    replica.db
      .query(
        "INSERT INTO mobile_view_preferences (key, view_id) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET view_id = excluded.view_id",
      )
      .run(key, viewId);
    setSelection({ key, id: viewId });
  };
  const groupProp =
    props.find((p) => p.id === active.group && p.type === "select") ??
    props.find((p) => p.type === "select") ??
    null;
  const addRecord = async (option: string | null) => {
    if (pending.current) return;
    pending.current = true;
    setCreating(true);
    setMutationError(null);
    try {
      const rec = await client.createRecord(
        id,
        option && groupProp ? { [groupProp.id]: option } : {},
      );
      if (session.isCurrent()) router.push(`/record/${rec.id}`);
    } catch (e) {
      setMutationError(String(e));
    } finally {
      pending.current = false;
      setCreating(false);
    }
  };
  const canOrder = manualOrderAllowed(query, active.filter.rules, active.sort);
  const run = async (job: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setMutationError(null);
    try {
      await job();
      if (session.isCurrent()) await refetch();
    } catch (e) {
      setMutationError(String(e));
    } finally {
      pending.current = false;
    }
  };
  const moveNeighbor = (rid: string, direction: "up" | "down") =>
    void run(async () => {
      if (!canOrder) throw new Error("清除搜索、筛选和排序后再调整顺序");
      if (active.layout === "board" && groupProp) {
        const current = rows.data?.records.find((r) => r.id === rid);
        if (!current) return;
        const options = groupProp.config?.options ?? [];
        const currentValue = current.cells[groupProp.id];
        const column =
          typeof currentValue === "string" && options.includes(currentValue)
            ? currentValue
            : null;
        const anchor = await findManualNeighbor(
          (start) => client.queryRecords(id, { offset: start, limit: 200 }),
          rid,
          direction,
          (record) => {
            const value = record.cells[groupProp.id];
            return column === null
              ? typeof value !== "string" || !options.includes(value)
              : value === column;
          },
          session.isCurrent,
        );
        if (anchor)
          await client.moveRecord(
            rid,
            anchor.id,
            direction === "up" ? "before" : "after",
          );
        return;
      }
      const records = rows.data?.records ?? [];
      const index = records.findIndex((r) => r.id === rid);
      let previous, next;
      if (direction === "up" && index === 0 && offset > 0)
        previous = (
          await client.queryRecords(id, { offset: offset - 1, limit: 1 })
        ).records[0];
      if (
        direction === "down" &&
        index === records.length - 1 &&
        rows.data?.hasMore
      )
        next = (
          await client.queryRecords(id, {
            offset: offset + records.length,
            limit: 1,
          })
        ).records[0];
      const anchor = adjacentAnchor(records, rid, direction, previous, next);
      if (anchor)
        await client.moveRecord(
          rid,
          anchor.id,
          direction === "up" ? "before" : "after",
        );
    });
  const recordActions = (rid: string) => {
    const records = rows.data?.records ?? [],
      index = records.findIndex((r) => r.id === rid);
    return [
      {
        id: "up",
        title: "上移记录",
        disabled:
          !canOrder || (active.layout !== "board" && index === 0 && !offset),
        onPress: () => moveNeighbor(rid, "up"),
      },
      {
        id: "down",
        title: "下移记录",
        disabled:
          !canOrder ||
          (active.layout !== "board" &&
            index === records.length - 1 &&
            !rows.data?.hasMore),
        onPress: () => moveNeighbor(rid, "down"),
      },
      {
        id: "anchor",
        title: "选择目标位置…",
        disabled: !canOrder,
        onPress: () => setOrdering(rid),
      },
    ];
  };
  const unsupported = active.layout !== "table" && active.layout !== "board";
  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <Stack.Screen options={{ title: meta.data?.db?.name ?? "数据库" }} />
      {mutationError ? <ErrorBanner message={mutationError} /> : null}
      {meta.error || rows.error ? (
        <ErrorBanner message="本地数据加载失败，点按重试" onRetry={refetch} />
      ) : null}
      <View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ padding: 8, gap: 8 }}
        >
          {views.map((view) => (
            <Pressable
              key={view.id}
              accessibilityRole="button"
              accessibilityState={{ selected: view.id === active.id }}
              style={{
                padding: 12,
                borderRadius: 8,
                backgroundColor:
                  view.id === active.id ? tokens.accentSoft : tokens.surface,
              }}
              onPress={() => choose(view.id)}
            >
              <Text style={{ color: tokens.fg }}>{view.name}</Text>
            </Pressable>
          ))}
          <NativeButton
            onPress={() =>
              router.push(
                `/manage/view/${id}?viewId=new` as Parameters<
                  typeof router.push
                >[0],
              )
            }
          >
            新建视图
          </NativeButton>
        </ScrollView>
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
        }}
      >
        <NativeHost matchContents style={{ flex: 1, minHeight: 44 }}>
          <RecordTextInput
            text={query}
            placeholder="搜索记录"
            onChangeText={(text) => {
              setQuery(text);
              setPage({ key: "", offset: 0 });
            }}
            style={{ padding: 12 }}
          />
        </NativeHost>
        <NativeButton
          onPress={() =>
            router.push(
              `/manage/view/${id}?viewId=${encodeURIComponent(active.id)}` as Parameters<
                typeof router.push
              >[0],
            )
          }
        >
          筛选与视图
        </NativeButton>
      </View>
      {!canOrder ? (
        <Text style={{ color: tokens.muted, paddingHorizontal: 16 }}>
          清除搜索、筛选和排序后可调整记录顺序；仍可移动分组。
        </Text>
      ) : null}
      {unsupported ? (
        <Text style={{ padding: 12, color: tokens.muted }}>
          此视图的
          {active.layout === "calendar"
            ? "日历"
            : active.layout === "timeline"
              ? "时间轴"
              : active.layout}
          布局暂以列表显示；原有设置已保留。
        </Text>
      ) : null}
      <View style={{ flex: 1 }}>
        {rows.loading && active.layout === "board" ? (
          <Text style={{ padding: 16, color: tokens.muted }}>加载中…</Text>
        ) : null}
        {active.layout === "board" && groupProp ? (
          <BoardView
            records={rows.data?.records ?? []}
            props={visible}
            groupProp={groupProp}
            onOpenRecord={(rid) => router.push(`/record/${rid}`)}
            onAddRecord={(option) => void addRecord(option)}
            recordActions={recordActions}
            onMoveColumn={(option, anchor, where) =>
              void run(() =>
                client.moveSelectOption(groupProp.id, option, anchor, where),
              )
            }
            onMoveRecord={(rid, option) => {
              if (pending.current) return;
              pending.current = true;
              void client
                .updateRecord(rid, { [groupProp.id]: option })
                .catch((e) => setMutationError(String(e)))
                .finally(() => {
                  pending.current = false;
                });
            }}
          />
        ) : (
          <FlashList
            data={rows.data?.records ?? []}
            keyExtractor={(record) => record.id}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => void refresh()}
              />
            }
            renderItem={({ item }) => (
              <RecordCard
                record={item}
                props={visible}
                actions={recordActions(item.id)}
                onPress={() => router.push(`/record/${item.id}`)}
              />
            )}
            ListEmptyComponent={
              rows.error || meta.error ? null : rows.loading || meta.loading ? (
                <Text style={{ padding: 16, color: tokens.muted }}>
                  加载中…
                </Text>
              ) : (
                <EmptyState
                  title={
                    query || active.filter.rules.length
                      ? "没有匹配的记录"
                      : "还没有记录"
                  }
                  hint={
                    query || active.filter.rules.length
                      ? "调整搜索或筛选条件"
                      : "点按新建记录开始"
                  }
                />
              )
            }
            contentContainerStyle={{ paddingBottom: 20 }}
          />
        )}
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          padding: 12,
          paddingBottom: Math.max(16, insets.bottom),
        }}
      >
        <Pressable
          disabled={!offset || rows.loading}
          style={{ padding: 12 }}
          onPress={() =>
            setPage({ key: pageKey, offset: Math.max(0, offset - PAGE) })
          }
        >
          <Text style={{ color: offset ? tokens.accent : tokens.muted }}>
            上一页
          </Text>
        </Pressable>
        <Text style={{ color: tokens.muted }}>
          {rows.data?.total ?? 0} 条 · 第 {Math.floor(offset / PAGE) + 1} 页
        </Text>
        <Pressable
          disabled={!rows.data?.hasMore || rows.loading}
          style={{ padding: 12 }}
          onPress={() => setPage({ key: pageKey, offset: offset + PAGE })}
        >
          <Text
            style={{ color: rows.data?.hasMore ? tokens.accent : tokens.muted }}
          >
            下一页
          </Text>
        </Pressable>
        {Platform.OS === "android" ? (
          <MaterialFab
            label={creating ? "创建中…" : "新建记录"}
            onPress={() => void addRecord(null)}
          />
        ) : null}
      </View>
      {ordering ? (
        <RecordOrderSheet
          databaseId={id}
          recordId={ordering}
          props={props}
          onClose={() => setOrdering(null)}
          onMoved={() => void refetch()}
        />
      ) : null}
      <Stack.Toolbar placement="right" tintColor={tokens.accent}>
        <Stack.Toolbar.Button
          icon={Platform.OS === "ios" ? "plus" : undefined}
          onPress={() => void addRecord(null)}
        >
          新建记录
        </Stack.Toolbar.Button>
        <Stack.Toolbar.Button
          onPress={() =>
            router.push(
              `/manage/database/${id}` as Parameters<typeof router.push>[0],
            )
          }
        >
          管理
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
    </View>
  );
}
const styles = StyleSheet.create({ root: { flex: 1 } });
