import { FlashList } from "@shopify/flash-list";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AdaptiveFab } from "@/components/AdaptiveFab";
import { BoardView } from "@/components/BoardView";
import { DatabaseManageSheet } from "@/components/DatabaseManageSheet";
import { ViewSettingsSheet } from "@/components/ViewSettingsSheet";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { RecordCard } from "@/components/RecordCard";
import { useApiData, useLiveInvalidate } from "@/lib/api/hooks";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { emptyView, normalizeViews, type ViewDef } from "../../../../../src/shared/views/model.ts";
const PAGE = 60;

export default function DatabaseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter(), session = useSession(), { client, replica, workspaceId } = session;
  const { tokens } = useTheme();
  const pending = useRef(false);
  const [mutationError, setMutationError] = useState<string | null>(null), [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState(false), [manage, setManage] = useState(false);
  const [query, setQuery] = useState(""), [page, setPage] = useState({ key: "", offset: 0 });
  const key = `${workspaceId}:${id}`;
  const savedPreference = useMemo(() => {
    replica.db.exec("CREATE TABLE IF NOT EXISTS mobile_view_preferences (key TEXT PRIMARY KEY, view_id TEXT NOT NULL)");
    return (replica.db.query("SELECT view_id FROM mobile_view_preferences WHERE key = ?").get(key) as { view_id: string } | null)?.view_id;
  }, [replica.db, key]);
  const [selection, setSelection] = useState<{ key: string; id: string } | null>(null);
  const preferred = selection?.key === key ? selection.id : savedPreference;
  const fetchMetadata = useCallback(async () => { const [dbs, props] = await Promise.all([client.listDatabases(), client.listProperties(id)]); return { db: dbs.find(d => d.id === id) ?? null, props }; }, [client, id]);
  const meta = useApiData(fetchMetadata);
  const views = useMemo(() => normalizeViews(meta.data?.db?.meta?.views), [meta.data?.db?.meta?.views]);
  const active = views.find(v => v.id === preferred) ?? views[0]!;
  const props = useMemo(() => (meta.data?.props ?? []).slice().sort((a, b) => a.position - b.position), [meta.data?.props]);
  const visible = useMemo(() => props.filter(p => !active.hidden.includes(p.id)), [props, active.hidden]);
  const pageKey = `${key}:${active.id}:${JSON.stringify(active.filter)}:${JSON.stringify(active.sort)}:${query}`;
  const offset = page.key === pageKey ? page.offset : 0;
  const fetchRecords = useCallback(async () => client.queryRecords(id, { search: query, filter: active.filter, sort: active.sort, offset, limit: PAGE }), [client, id, query, active.filter, active.sort, offset]);
  const rows = useApiData(fetchRecords);
  const { refetch: refetchMeta } = meta, { refetch: refetchRows } = rows;
  const refetch = useCallback(async () => { await Promise.all([refetchMeta(), refetchRows()]); }, [refetchMeta, refetchRows]);
  useLiveInvalidate(["records", "properties", "databases"], () => void refetch());
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => { setRefreshing(true); try { await session.syncNow(); await refetch(); } catch (e) { setMutationError(String(e)); } finally { setRefreshing(false); } };
  const choose = (viewId: string) => { replica.db.query("INSERT INTO mobile_view_preferences (key, view_id) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET view_id = excluded.view_id").run(key, viewId); setSelection({ key, id: viewId }); };
  const saveView = async (next: ViewDef) => {
    // Re-read immediately before writing so concurrent local metadata edits survive.
    const latest = (await client.listDatabases()).find(d => d.id === id);
    if (!session.isCurrent()) throw new Error("工作区已切换，请重新打开视图");
    const raw = Array.isArray(latest?.meta?.views) ? latest.meta.views : views;
    const exists = raw.some(v => !!v && typeof v === "object" && (v as { id?: string }).id === next.id);
    const updated = exists ? raw.map(v => !!v && typeof v === "object" && (v as { id?: string }).id === next.id ? { ...v, ...next } : v) : [...raw, next];
    await client.updateDatabase(id, { meta: { views: updated } }); choose(next.id); await meta.refetch();
  };
  const groupProp = props.find(p => p.id === active.group && p.type === "select") ?? props.find(p => p.type === "select") ?? null;
  const addRecord = async (option: string | null) => {
    if (pending.current) return; pending.current = true; setCreating(true); setMutationError(null);
    try { const rec = await client.createRecord(id, option && groupProp ? { [groupProp.id]: option } : {}); if (session.isCurrent()) router.push(`/record/${rec.id}`); }
    catch (e) { setMutationError(String(e)); } finally { pending.current = false; setCreating(false); }
  };
  const unsupported = active.layout !== "table" && active.layout !== "board";
  return <View style={[styles.root, { backgroundColor: tokens.bg }]}>
    <Stack.Screen options={{ title: meta.data?.db?.name ?? "数据库", headerRight: () => <Pressable accessibilityLabel="管理数据库" hitSlop={10} onPress={() => setManage(true)}><Text style={{ color: tokens.accent }}>管理</Text></Pressable> }} />
    {mutationError ? <ErrorBanner message={mutationError} /> : null}
    {meta.error || rows.error ? <ErrorBanner message="本地数据加载失败，点按重试" onRetry={refetch} /> : null}
    <View><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 8, gap: 8 }}>
      {views.map(view => <Pressable key={view.id} accessibilityRole="button" accessibilityState={{ selected: view.id === active.id }} style={{ padding: 12, borderRadius: 8, backgroundColor: view.id === active.id ? tokens.accentSoft : tokens.surface }} onPress={() => choose(view.id)}><Text style={{ color: tokens.fg }}>{view.name}</Text></Pressable>)}
      <Pressable style={{ padding: 12 }} onPress={() => { void saveView(emptyView("table", "新视图")).catch(e => setMutationError(String(e))); }}><Text style={{ color: tokens.accent }}>新建视图</Text></Pressable>
    </ScrollView></View>
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16 }}><TextInput accessibilityLabel="搜索当前数据库" placeholder="搜索记录" placeholderTextColor={tokens.muted} value={query} onChangeText={setQuery} style={{ color: tokens.fg, flex: 1, paddingVertical: 12 }} /><Pressable style={{ padding: 12 }} onPress={() => setSettings(true)}><Text style={{ color: tokens.accent }}>筛选与视图</Text></Pressable></View>
    {unsupported ? <Text style={{ padding: 12, color: tokens.muted }}>此视图的{active.layout === "calendar" ? "日历" : active.layout === "timeline" ? "时间轴" : active.layout}布局暂以列表显示；原有设置已保留。</Text> : null}
    <View style={{ flex: 1 }}>{active.layout === "board" && groupProp ? <BoardView records={rows.data?.records ?? []} props={visible} groupProp={groupProp} onOpenRecord={rid => router.push(`/record/${rid}`)} onAddRecord={option => void addRecord(option)} onMoveRecord={(rid, option) => { if (pending.current) return; pending.current = true; void client.updateRecord(rid, { [groupProp.id]: option }).catch(e => setMutationError(String(e))).finally(() => { pending.current = false; }); }} /> : <FlashList data={rows.data?.records ?? []} keyExtractor={record => record.id} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />} renderItem={({ item }) => <RecordCard record={item} props={visible} onPress={() => router.push(`/record/${item.id}`)} />} ListEmptyComponent={rows.loading || meta.loading ? <Text style={{ padding: 16, color: tokens.muted }}>加载中…</Text> : <EmptyState title={query || active.filter.rules.length ? "没有匹配的记录" : "还没有记录"} hint={query || active.filter.rules.length ? "调整搜索或筛选条件" : "点按新建记录开始"} />} contentContainerStyle={{ paddingBottom: 20 }} />}</View>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 12, paddingBottom: 90 }}>
      <Pressable disabled={!offset || rows.loading} style={{ padding: 12 }} onPress={() => setPage({ key: pageKey, offset: Math.max(0, offset - PAGE) })}><Text style={{ color: offset ? tokens.accent : tokens.muted }}>上一页</Text></Pressable>
      <Text style={{ color: tokens.muted }}>{rows.data?.total ?? 0} 条 · 第 {Math.floor(offset / PAGE) + 1} 页</Text>
      <Pressable disabled={!rows.data?.hasMore || rows.loading} style={{ padding: 12 }} onPress={() => setPage({ key: pageKey, offset: offset + PAGE })}><Text style={{ color: rows.data?.hasMore ? tokens.accent : tokens.muted }}>下一页</Text></Pressable>
    </View>
    {settings ? <ViewSettingsSheet view={active} props={props} onClose={() => setSettings(false)} onSave={saveView} /> : null}
    {manage && meta.data?.db ? <DatabaseManageSheet database={meta.data.db} props={props} onClose={() => setManage(false)} /> : null}
    <AdaptiveFab label={creating ? "创建中…" : "新建记录"} onPress={() => void addRecord(null)} />
  </View>;
}
const styles = StyleSheet.create({ root: { flex: 1 } });
