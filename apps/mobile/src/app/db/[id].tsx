import { ColumnSheet } from "@/components/database/ColumnSheet";
import { createMutationGate } from "@/lib/browse/form-guard";
import { ToolbarIcon } from "@/components/database/ToolbarIcon";
import { RangeMenu } from "@/components/database/RangeMenu";
import * as Clipboard from "expo-clipboard";
import { rectangle, preparePaste, serializeGrid } from "@/lib/grid-selection";
import { NativeMenu } from "@/components/native/NativeMenu";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  usePreventRemove,
  useHeaderHeight,
} from "expo-router/react-navigation";
import { Grid, type Cell } from "@/components/database/Grid";
import { DateViews } from "@/components/database/DateViews";
import { CellSheet } from "@/components/database/CellSheet";
import {
  recordWriter,
  prepareCell,
  withRecordDrafts,
  hasDirtyWriters,
} from "@/lib/database-drafts";
import type { PropInfo } from "@/lib/api/sdk";
import type { ViewDef } from "../../../../../src/shared/views/model";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BoardPager } from "@/components/database/BoardPager";
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
import { ErrorBanner } from "@/components/ErrorBanner";

import { useApiData, useLiveInvalidate } from "@/lib/api/hooks";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import {
  normalizeViews,
  calcKindsFor,
  calcLabel,
  applyFilter,
  searchRecords,
} from "../../../../../src/shared/views/model.ts";
const PAGE = 60;

export default function DatabaseScreen() {
  const { id, view } = useLocalSearchParams<{ id: string; view?: string }>();
  const { workspaceId } = useSession();
  return <DatabaseContent key={`${workspaceId}:${id}:${view ?? ""}`} />;
}
function DatabaseContent() {
  const { id, view: requestedView } = useLocalSearchParams<{
    id: string;
    view?: string;
  }>();
  const router = useRouter(),
    session = useSession(),
    { client, replica, workspaceId } = session;
  const { tokens } = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const [operation] = useState(createMutationGate);
  const [mutationError, setMutationError] = useState<string | null>(null),
    [creating, setCreating] = useState(false);
  const [ordering, setOrdering] = useState<string | null>(null);
  const [viewMenu, setViewMenu] = useState<ViewDef | null>(null);
  const [column, setColumn] = useState<PropInfo | null>(null);
  const [range, setRange] = useState<Cell | null>(null),
    [batchProp, setBatchProp] = useState<PropInfo | null>(null);
  const [datePreset, setDatePreset] = useState<Record<string, unknown>>({});
  const [notice, setNotice] = useState("");
  const localViews = useRef(
    new Map<string, { cell: Cell | null; range: Cell | null; size: number }>(),
  );
  const [exitAllowed, setExitAllowed] = useState(false);
  const [cell, setCell] = useState<Cell | null>(null),
    [editing, setEditing] = useState<Cell | null>(null),
    [fieldSheet, setFieldSheet] = useState<PropInfo | null>(null),
    [selected, setSelected] = useState(new Set<string>()),
    [windowSize, setWindowSize] = useState(60),
    [revision, setRevision] = useState(0),
    [searchOpen, setSearchOpen] = useState(false);
  const [, redraw] = useState(0);
  const observed = useRef(new Map<string, () => void>());
  const writer = (rid: string) => {
    const w = recordWriter(replica.service, rid);
    if (!observed.current.has(rid)) {
      const fn = () => redraw((n) => n + 1);
      w.listeners.add(fn);
      observed.current.set(rid, () => w.listeners.delete(fn));
    }
    return w.drafts;
  };
  useEffect(() => {
    const listeners = observed.current;
    return () => {
      listeners.forEach((fn) => fn());
      listeners.clear();
    };
  }, [replica, id]);
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
  const preferred =
    selection?.key === key
      ? selection.id
      : requestedView
        ? requestedView.startsWith("v_")
          ? requestedView
          : `v_${requestedView}`
        : savedPreference;
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
  const fetchRecords = useCallback(async () => {
    void revision;
    const versions = new Map(
      [...observed.current.keys()].map((rid) => [
        rid,
        recordWriter(replica.service, rid).drafts.acknowledgedVersion,
      ]),
    );
    const records = [];
    let total = 0,
      calc: Record<string, string> = {};
    for (let offset = 0; ; offset += 200) {
      const result = await client.queryRecords(id, {
        search: query,
        filter: active.filter,
        sort: active.sort,
        calc: active.calc,
        offset,
        limit: Math.min(200, Math.max(1, windowSize - offset)),
      });
      if (!session.isCurrent()) throw new Error("工作区已切换");
      for (const record of result.records)
        recordWriter(replica.service, record.id);
      records.push(...result.records);
      total = result.total;
      calc = result.calc;
      if (!result.hasMore || records.length >= windowSize) break;
    }
    return { records, total, calc, versions, hasMore: records.length < total };
  }, [
    client,
    id,
    query,
    active.filter,
    active.sort,
    active.calc,
    windowSize,
    revision,
    session,
    replica,
  ]);
  const rows = useApiData(fetchRecords, pageKey);
  useEffect(() => {
    for (const record of rows.data?.records ?? []) {
      const entry = recordWriter(replica.service, record.id);
      if (!observed.current.has(record.id)) {
        const changed = () => redraw((n) => n + 1);
        entry.listeners.add(changed);
        observed.current.set(record.id, () => entry.listeners.delete(changed));
      }
      const version = rows.data?.versions.get(record.id);
      if (version !== undefined)
        recordWriter(replica.service, record.id).drafts.reconcile(
          record.cells,
          version,
        );
    }
  }, [rows.data, replica]);
  if (rows.data) {
    const valid = validPageOffset(offset, rows.data.total, PAGE);
    if (valid !== offset) setPage({ key: pageKey, offset: valid });
  }
  const { refetch: refetchMeta } = meta,
    { refetch: refetchRows } = rows;
  const refetch = useCallback(async () => {
    await Promise.all([refetchMeta(), refetchRows()]);
  }, [refetchMeta, refetchRows]);
  useLiveInvalidate(["records", "properties", "databases"], () => {
    setRevision((n) => n + 1);
    void refetch();
  });
  const finish = async () => {
    for (const rid of observed.current.keys()) {
      const drafts = writer(rid);
      if (!drafts.dirty) continue;
      const result = await drafts.flush((pid, value) =>
        prepareCell(props, pid, value),
      );
      if (!result.ok) {
        setMutationError(result.error);
        return false;
      }
    }
    setEditing(null);
    Keyboard.dismiss();
    return true;
  };
  usePreventRemove(
    !exitAllowed && hasDirtyWriters(replica.service),
    ({ repeat }) => {
      void finish().then((ok) => {
        if (ok) {
          setExitAllowed(true);
          repeat();
        } else {
          Alert.alert(
            "修改尚未保存",
            "仍有未保存修改，可以留下修正后重试，或保留草稿离开。",
            [
              { text: "留下修正", style: "cancel" },
              {
                text: "保留草稿离开",
                onPress: () => {
                  setExitAllowed(true);
                  repeat();
                },
              },
            ],
          );
        }
      });
    },
  );
  const saveCells = async (rid: string, values: Record<string, unknown>) => {
    if (!session.isCurrent()) return false;
    for (const [pid, value] of Object.entries(values))
      writer(rid).stage(pid, value);
    const result = await writer(rid).flush((pid, v) =>
      prepareCell(props, pid, v),
    );
    if (!result.ok) {
      setMutationError(result.error);
      return false;
    }
    try {
      const saved = await client.getRecord(rid);
      if (
        !applyFilter(searchRecords([saved], props, query), props, active.filter)
          .length
      )
        setNotice("记录已保存；不再满足当前筛选，已从视图移除");
    } catch {
      setNotice("已保存，等待视图刷新");
    }
    setRevision((n) => n + 1);
    return true;
  };
  const saveCell = (rid: string, prop: PropInfo, value: unknown) =>
    saveCells(rid, { [prop.id]: value });
  const updateView = async (patch: Partial<ViewDef>) => {
    const db = (await client.listDatabases()).find((d) => d.id === id);
    if (!db) return;
    await client.updateDatabase(id, {
      meta: {
        views: normalizeViews(db.meta?.views).map((v) =>
          v.id === active.id ? { ...v, ...patch } : v,
        ),
      },
    });
    await refetchMeta();
  };
  const currentWriter = useMemo(
    () => (cell ? recordWriter(replica.service, cell.record) : null),
    [replica, cell],
  );
  useEffect(() => {
    if (!currentWriter) return;
    const changed = () => redraw((n) => n + 1);
    currentWriter.listeners.add(changed);
    return () => {
      currentWriter.listeners.delete(changed);
    };
  }, [currentWriter]);
  const currentValue = cell
    ? currentWriter?.drafts.fields.has(cell.prop)
      ? currentWriter.drafts.fields.get(cell.prop)!.value
      : rows.data?.records.find((r) => r.id === cell.record)?.cells[cell.prop]
    : null;
  const tapCell = async (next: Cell) => {
    if (range) {
      setCell(next);
      return;
    }
    if (editing && !(await finish())) return;
    if (cell?.record !== next.record || cell.prop !== next.prop) {
      setCell(next);
      return;
    }
    const prop = props.find((p) => p.id === next.prop);
    if (!prop) return;
    if (prop.type === "checkbox") {
      await saveCell(next.record, prop, !currentValue);
      return;
    }
    if (["text", "number", "url"].includes(prop.type)) setEditing(next);
    else setFieldSheet(prop);
  };
  const choose = async (viewId: string) => {
    if (!(await finish())) return;
    localViews.current.set(active.id, { cell, range, size: windowSize });
    const saved = localViews.current.get(viewId);
    setWindowSize(saved?.size ?? 60);
    setCell(saved?.cell ?? null);
    setRange(saved?.range ?? null);
    setSelected(new Set());
    replica.db
      .query(
        "INSERT INTO mobile_view_preferences (key, view_id) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET view_id = excluded.view_id",
      )
      .run(key, viewId);
    setSelection({ key, id: viewId });
  };
  useEffect(() => {
    if (!exitAllowed) return;
    const frame = requestAnimationFrame(() => setExitAllowed(false));
    return () => cancelAnimationFrame(frame);
  }, [exitAllowed]);
  const groupProp =
    props.find((p) => p.id === active.group && p.type === "select") ??
    props.find((p) => p.type === "select") ??
    null;
  const addRecord = async (option: string | null) => {
    if (!(await finish())) return;
    const release = operation.begin();
    if (!release) return;
    setCreating(true);
    setMutationError(null);
    try {
      const rec = await client.createRecord(
        id,
        option && groupProp
          ? { [groupProp.id]: option }
          : active.layout === "calendar" || active.layout === "timeline"
            ? datePreset
            : {},
      );
      if (session.isCurrent()) router.push(`/record/${rec.id}`);
    } catch (e) {
      setMutationError(String(e));
    } finally {
      release();
      setCreating(false);
    }
  };
  const canOrder = manualOrderAllowed(query, active.filter.rules, active.sort);
  const run = async (job: () => Promise<unknown>) => {
    const release = operation.begin();
    if (!release) return;
    setMutationError(null);
    try {
      await job();
      if (session.isCurrent()) await refetch();
    } catch (e) {
      setMutationError(String(e));
    } finally {
      release();
    }
  };
  const moveNeighbor = (rid: string, direction: "up" | "down") =>
    void run(async () => {
      if (!canOrder) throw new Error("清除搜索、筛选和排序后再调整顺序");
      if (active.layout === "board" && groupProp) {
        const current = await client.getRecord(rid);
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

  const valueAt = (c: Cell) => {
    const draft = writer(c.record).fields.get(c.prop);
    return draft
      ? draft.value
      : rows.data?.records.find((r) => r.id === c.record)?.cells[c.prop];
  };
  const selectionAction = async (kind: "copy" | "paste" | "clear" | "fill") => {
    if (!cell) return;
    try {
      const rect = rectangle(
        rows.data?.records ?? [],
        visible,
        range ?? cell,
        cell,
      );
      if (kind === "copy") {
        await Clipboard.setStringAsync(
          serializeGrid(rect.map((row) => row.map(valueAt))),
        );
        return;
      }
      const changes =
        kind === "paste"
          ? preparePaste(
              await Clipboard.getStringAsync(),
              rows.data?.records ?? [],
              visible,
              cell,
            )
          : rect.flatMap((row) =>
              row.map((c, i) => ({
                cell: c,
                value: kind === "clear" ? null : valueAt(rect[0]![i]!),
              })),
            );
      for (const change of changes)
        writer(change.cell.record).stage(change.cell.prop, change.value);
      if (await finish()) void refetchRows();
    } catch (e) {
      setMutationError(String(e));
    }
  };
  const batch = async (kind: "delete" | "duplicate") => {
    const failed = new Set<string>();
    await run(async () => {
      if (!(await finish())) return;
      for (const rid of selected) {
        try {
          if (kind === "delete") await client.deleteRecord(rid);
          else {
            const record = await client.getRecord(rid);
            await client.createRecord(id, record.cells);
          }
        } catch {
          failed.add(rid);
        }
      }
      setSelected(failed);
      if (failed.size)
        throw new Error(
          `${selected.size - failed.size} 条成功，${failed.size} 条失败；重试仅处理失败项`,
        );
    });
  };
  const moveCell = async (delta: number) => {
    if (!cell || !(await finish())) return;
    const index =
      (rows.data?.records.findIndex((r) => r.id === cell.record) ?? -1) *
        visible.length +
      visible.findIndex((p) => p.id === cell.prop) +
      delta;
    const record = rows.data?.records[Math.floor(index / visible.length)],
      prop = visible[index % visible.length];
    if (record && prop) {
      const c = { record: record.id, prop: prop.id };
      setCell(c);
      if (["text", "number", "url"].includes(prop.type)) setEditing(c);
      else setFieldSheet(prop);
    }
  };
  return (
    <GestureHandlerRootView
      style={[styles.root, { backgroundColor: tokens.bg }]}
    >
      <KeyboardAvoidingView
        style={{ flex: 1, paddingTop: headerHeight }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Stack.Screen
          options={{
            title: meta.data?.db?.name ?? "数据库",
            headerTransparent: true,
            headerShadowVisible: false,
            headerStyle: { backgroundColor: "transparent" },
          }}
        />
        {!!notice && (
          <Pressable onPress={() => setNotice("")} style={{ padding: 8 }}>
            <Text style={{ color: tokens.muted }}>{notice}</Text>
          </Pressable>
        )}
        {mutationError ? (
          <ErrorBanner
            message={mutationError}
            onRetry={() => {
              void finish().then((ok) => {
                if (ok) {
                  setMutationError(null);
                  void refetch();
                }
              });
            }}
          />
        ) : null}
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
                  paddingVertical: 7,
                  paddingHorizontal: 12,
                  borderRadius: 8,
                  backgroundColor:
                    view.id === active.id ? tokens.accentSoft : tokens.surface,
                }}
                onPress={() => void choose(view.id)}
                onLongPress={() => setViewMenu(view)}
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
              ＋
            </NativeButton>
          </ScrollView>
        </View>
        <View
          style={{
            display: searchOpen ? "flex" : "none",
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
        </View>
        {!!active.filter.rules.length && (
          <View>
            <ScrollView horizontal>
              {active.filter.rules.map((rule) => (
                <Pressable
                  key={rule.id}
                  onPress={() =>
                    void run(() =>
                      updateView({
                        filter: {
                          ...active.filter,
                          rules: active.filter.rules.filter(
                            (r) => r.id !== rule.id,
                          ),
                        },
                      }),
                    )
                  }
                  style={{ padding: 8 }}
                >
                  <Text style={{ color: tokens.fg }}>
                    {props.find((p) => p.id === rule.prop)?.name} ·{" "}
                    {String(rule.value ?? rule.cond)} ×
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}
        {!canOrder ? (
          <Text style={{ color: tokens.muted, paddingHorizontal: 16 }}>
            清除搜索、筛选和排序后可调整记录顺序；仍可移动分组。
          </Text>
        ) : null}
        <View style={{ flex: 1 }}>
          {rows.loading && active.layout === "board" ? (
            <Text style={{ padding: 16, color: tokens.muted }}>加载中…</Text>
          ) : null}
          {active.layout === "board" && groupProp ? (
            <BoardPager
              databaseId={id}
              view={active}
              search={query}
              revision={revision}
              props={visible}
              groupProp={groupProp}
              onOpenRecord={(rid) => {
                void finish().then((ok) => {
                  if (ok) router.push(`/record/${rid}`);
                });
              }}
              onAddRecord={(option) => void addRecord(option)}
              recordActions={recordActions}
              onReorderRecord={
                canOrder
                  ? (rid, anchor, where) => {
                      void run(() => client.moveRecord(rid, anchor, where));
                    }
                  : undefined
              }
              onMoveColumn={(option, anchor, where) =>
                void run(() =>
                  client.moveSelectOption(groupProp.id, option, anchor, where),
                )
              }
              onMoveRecord={(rid, option) =>
                void saveCell(rid, groupProp, option)
              }
            />
          ) : active.layout === "board" ? (
            <NativeButton onPress={() => router.push(`/manage/database/${id}`)}>
              新增单选字段以设置看板分组
            </NativeButton>
          ) : active.layout === "calendar" || active.layout === "timeline" ? (
            <DateViews
              key={active.id}
              databaseId={id}
              view={active}
              props={props}
              search={query}
              revision={revision}
              onView={(patch) =>
                void updateView(patch).catch((e) => setMutationError(String(e)))
              }
              onOpen={(rid) => {
                void finish().then((ok) => {
                  if (ok) router.push(`/record/${rid}`);
                });
              }}
              onCreate={(values) =>
                void run(async () => {
                  const r = await client.createRecord(id, values);
                  router.push(`/record/${r.id}`);
                })
              }
              onSave={saveCell}
              onSaveCells={saveCells}
              onCreateContext={setDatePreset}
              onAddDate={() => router.push(`/manage/database/${id}`)}
            />
          ) : (
            <Grid
              key={active.id}
              stateKey={`${key}:${active.id}`}
              records={(rows.data?.records ?? []).map((record) =>
                withRecordDrafts(replica.service, record),
              )}
              props={visible}
              active={cell}
              range={range}
              onRangeFocus={setCell}
              onRangeAnchor={setRange}
              editing={editing}
              value={currentValue}
              selected={selected}
              wrap={!!active.wrap}
              calc={rows.data?.calc ?? {}}
              onCell={(next) => void tapCell(next)}
              onRange={(c) => {
                setRange(c);
                setCell(c);
              }}
              onSelect={(rid) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(rid)) next.delete(rid);
                  else next.add(rid);
                  return next;
                })
              }
              onOpen={(rid) =>
                void finish().then((ok) => {
                  if (ok) router.push(`/record/${rid}`);
                })
              }
              onHeader={(p) =>
                p ? setColumn(p) : router.push(`/manage/database/${id}`)
              }
              onAdd={() => void addRecord(null)}
              onMore={() => {
                if (!rows.loading && rows.data?.hasMore)
                  setWindowSize((n) => n + 60);
              }}
              onText={(value) => {
                if (editing) writer(editing.record).stage(editing.prop, value);
              }}
              onDone={() => {
                if (editing)
                  void finish().then((ok) => {
                    if (ok) void refetchRows();
                  });
              }}
            />
          )}
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 8,
            paddingVertical: 2,
            paddingBottom: Math.max(4, insets.bottom),
          }}
        >
          {selected.size > 0 ? (
            <>
              <Text style={{ color: tokens.fg }}>{selected.size} 条</Text>
              <NativeMenu
                label="设值"
                items={props.map((p) => ({
                  id: p.id,
                  title: p.name,
                  onPress: () => setBatchProp(p),
                }))}
              />
              <NativeButton
                variant="text"
                onPress={() => void batch("duplicate")}
              >
                复制
              </NativeButton>
              <NativeButton
                variant="text"
                onPress={() =>
                  Alert.alert("删除记录", `删除 ${selected.size} 条？`, [
                    { text: "取消" },
                    {
                      text: "删除",
                      style: "destructive",
                      onPress: () => void batch("delete"),
                    },
                  ])
                }
              >
                删除
              </NativeButton>
              <NativeButton
                variant="text"
                onPress={() => setSelected(new Set())}
              >
                取消
              </NativeButton>
            </>
          ) : range ? (
            <>
              <RangeMenu onAction={selectionAction} />
              <NativeButton variant="text" onPress={() => setRange(null)}>
                取消
              </NativeButton>
            </>
          ) : (
            <>
              {editing && (
                <>
                  <NativeButton
                    variant="text"
                    onPress={() => void moveCell(-1)}
                  >
                    上一格
                  </NativeButton>
                  <NativeButton variant="text" onPress={() => void moveCell(1)}>
                    下一格
                  </NativeButton>
                </>
              )}
              {editing && (
                <NativeButton
                  variant="text"
                  onPress={() => {
                    const p = props.find((p) => p.id === editing.prop);
                    if (p) {
                      setFieldSheet(p);
                      setEditing(null);
                      Keyboard.dismiss();
                    }
                  }}
                >
                  展开
                </NativeButton>
              )}
              {editing ? (
                <NativeButton
                  onPress={() =>
                    void finish().then((ok) => {
                      if (ok) void refetchRows();
                    })
                  }
                >
                  完成编辑
                </NativeButton>
              ) : (
                <ToolbarIcon
                  kind="search"
                  label="搜索"
                  onPress={() => setSearchOpen((v) => !v)}
                />
              )}
              {!editing && (
                <>
                  <ToolbarIcon
                    kind="filter"
                    label={`筛选 ${active.filter.rules.length}`}
                    onPress={() =>
                      router.push(
                        `/manage/view/${id}?viewId=${active.id}&section=filter`,
                      )
                    }
                  />
                  {!!active.filter.rules.length && (
                    <Text style={{ color: tokens.fg }}>
                      {active.filter.rules.length}
                    </Text>
                  )}
                  <ToolbarIcon
                    kind="sort"
                    label={`排序 ${active.sort.length}`}
                    onPress={() =>
                      router.push(
                        `/manage/view/${id}?viewId=${active.id}&section=sort`,
                      )
                    }
                  />
                  {!!active.sort.length && (
                    <Text style={{ color: tokens.fg }}>
                      {active.sort.length}
                    </Text>
                  )}
                  <ToolbarIcon
                    kind="settings"
                    label="视图设置"
                    onPress={() =>
                      router.push(`/manage/view/${id}?viewId=${active.id}`)
                    }
                  />
                  <Text style={{ color: tokens.muted }}>
                    {rows.data?.total ?? 0} 条
                  </Text>
                </>
              )}
            </>
          )}
        </View>
        {viewMenu && (
          <ColumnSheet
            label={viewMenu.name}
            onClose={() => setViewMenu(null)}
            items={[
              {
                id: "rename",
                title: "重命名",
                onPress: () =>
                  router.push(`/manage/view/${id}?viewId=${viewMenu.id}`),
              },
              {
                id: "duplicate",
                title: "复制视图",
                onPress: () => {
                  void run(async () => {
                    const db = (await client.listDatabases()).find(
                      (d) => d.id === id,
                    );
                    if (!db) throw new Error("数据库已删除");
                    await client.updateDatabase(id, {
                      meta: {
                        views: [
                          ...normalizeViews(db.meta?.views),
                          {
                            ...viewMenu,
                            id: "v_" + Date.now().toString(36),
                            name: viewMenu.name + " 副本",
                          },
                        ],
                      },
                    });
                  });
                },
              },
              {
                id: "delete",
                title: "删除视图",
                destructive: true,
                onPress: () =>
                  Alert.alert("删除视图", "记录不会被删除", [
                    { text: "取消", style: "cancel" },
                    {
                      text: "删除",
                      style: "destructive",
                      onPress: () => {
                        void run(async () => {
                          const db = (await client.listDatabases()).find(
                            (d) => d.id === id,
                          );
                          const all = normalizeViews(db?.meta?.views);
                          if (all.length === 1)
                            throw new Error("至少保留一个视图");
                          await client.updateDatabase(id, {
                            meta: {
                              views: all.filter((v) => v.id !== viewMenu.id),
                            },
                          });
                        });
                      },
                    },
                  ]),
              },
            ]}
          />
        )}
        {column && (
          <ColumnSheet
            onClose={() => setColumn(null)}
            label={column.name}
            items={[
              {
                id: "edit",
                title: "编辑字段",
                onPress: () => router.push(`/manage/database/${id}`),
              },
              {
                id: "asc",
                title: "升序",
                onPress: () =>
                  void run(() =>
                    updateView({ sort: [{ prop: column.id, desc: false }] }),
                  ),
              },
              {
                id: "desc",
                title: "降序",
                onPress: () =>
                  void run(() =>
                    updateView({ sort: [{ prop: column.id, desc: true }] }),
                  ),
              },
              {
                id: "hide",
                title: "隐藏字段",
                onPress: () =>
                  void run(() =>
                    updateView({ hidden: [...active.hidden, column.id] }),
                  ),
              },
              ...([120, 160, 240, 320] as const).map((width) => ({
                id: String(width),
                title: `列宽 ${width}`,
                onPress: () =>
                  void run(() =>
                    client.updateProperty(column.id, {
                      config: { ...column.config, width },
                    }),
                  ),
              })),
              ...calcKindsFor(column.type).map((kind) => ({
                id: kind,
                title: calcLabel(kind),
                onPress: () =>
                  void run(() =>
                    updateView({
                      calc: { ...active.calc, [column.id]: kind },
                    }),
                  ),
              })),
              {
                id: "delete",
                title: "删除字段",
                destructive: true,
                onPress: () =>
                  Alert.alert("删除字段", "字段值也将被删除", [
                    { text: "取消" },
                    {
                      text: "删除",
                      style: "destructive",
                      onPress: () =>
                        void run(() => client.deleteProperty(column.id)),
                    },
                  ]),
              },
            ]}
          />
        )}
        {batchProp && (
          <CellSheet
            prop={batchProp}
            value={null}
            onClose={() => setBatchProp(null)}
            onSave={async (value) => {
              const failed = new Set<string>();
              for (const rid of selected)
                if (!(await saveCell(rid, batchProp, value))) failed.add(rid);
              setSelected(failed);
              if (failed.size)
                setMutationError(
                  `${selected.size - failed.size} 条成功，${failed.size} 条失败；重试仅处理失败项`,
                );
              return !failed.size;
            }}
          />
        )}
        {fieldSheet && cell && (
          <CellSheet
            key={cell.record + cell.prop}
            prop={fieldSheet}
            value={currentValue}
            onStage={(value) => writer(cell.record).stage(fieldSheet.id, value)}
            onClose={() => setFieldSheet(null)}
            onSave={(value) => saveCell(cell.record, fieldSheet, value)}
          />
        )}
        {ordering ? (
          <RecordOrderSheet
            databaseId={id}
            recordId={ordering}
            props={props}
            onClose={() => setOrdering(null)}
            onMoved={() => void refetch()}
          />
        ) : null}
        {Platform.OS === "android" ? (
          <Stack.Toolbar placement="right" asChild>
            <View style={{ flexDirection: "row" }}>
              <NativeButton variant="text" onPress={() => void addRecord(null)}>
                新建记录
              </NativeButton>
              <NativeMenu
                label="更多"
                items={[
                  {
                    id: "manage",
                    title: "管理数据库",
                    onPress: () => router.push(`/manage/database/${id}`),
                  },
                  {
                    id: "view",
                    title: "视图设置",
                    onPress: () =>
                      router.push(`/manage/view/${id}?viewId=${active.id}`),
                  },
                ]}
              />
            </View>
          </Stack.Toolbar>
        ) : (
          <Stack.Toolbar placement="right" tintColor={tokens.fg}>
            <Stack.Toolbar.Button
              disabled={creating}
              icon={Platform.OS === "ios" ? "plus" : undefined}
              onPress={() => void addRecord(null)}
            >
              新建记录
            </Stack.Toolbar.Button>
            <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="更多">
              <Stack.Toolbar.MenuAction
                onPress={() => router.push(`/manage/database/${id}`)}
              >
                管理数据库
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction
                onPress={() =>
                  router.push(`/manage/view/${id}?viewId=${active.id}`)
                }
              >
                视图设置
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction
                onPress={() => {
                  void finish().then((ok) => {
                    if (ok) void refetch();
                  });
                }}
              >
                刷新数据
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
          </Stack.Toolbar>
        )}
      </KeyboardAvoidingView>
    </GestureHandlerRootView>
  );
}
const styles = StyleSheet.create({ root: { flex: 1 } });
