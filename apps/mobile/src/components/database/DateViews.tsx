import { RNHostView } from "@expo/ui";
import { NativeSheet } from "../native/NativeSheet";
import { NativeButton } from "../native/NativeButton";
import type { ComponentRef } from "react";
import { useEdgeScroll } from "./useEdgeScroll";
import { timelineSpan, moveDates, resizeDate } from "@/lib/date-layout";
import { DragItem } from "./DragItem";
import { useEffect, useMemo, useState, useRef } from "react";
import {
  type ScrollView,
  Animated,
  View,
  Text,
  Pressable,
  useWindowDimensions,
} from "react-native";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { recordTitle } from "@/lib/format";
import type { PropInfo, RecordInfo } from "@/lib/api/sdk";
import type { ViewDef } from "../../../../../src/shared/views/model";
import {
  monthMatrix,
  toISO,
  today,
  parseDate,
  daysBetween,
} from "../../../../../src/shared/views/date";
import { NativeMenu } from "../native/NativeMenu";
import { CellSheet } from "./CellSheet";
export function DateViews({
  databaseId,
  view,
  props,
  search,
  revision,
  onView,
  onOpen,
  onCreate,
  onSave,
  onSaveCells,
  onAddDate,
  onCreateContext,
}: {
  databaseId: string;
  view: ViewDef;
  props: PropInfo[];
  search: string;
  revision: number;
  onView(v: Partial<ViewDef>): void;
  onOpen(id: string): void;
  onCreate(v: Record<string, unknown>): void;
  onSaveCells(id: string, cells: Record<string, unknown>): Promise<boolean>;
  onSave(id: string, p: PropInfo, v: unknown): Promise<boolean>;
  onAddDate(): void;
  onCreateContext(values: Record<string, unknown>): void;
}) {
  const { height: screenHeight } = useWindowDimensions();
  const [showDay, setShowDay] = useState(false);
  const session = useSession(),
    { tokens } = useTheme();
  const [cursor, setCursor] = useState(today),
    [day, setDay] = useState(toISO(today())),
    [undated, setUndated] = useState(false),
    [result, setResult] = useState<{
      key: string;
      records: RecordInfo[];
      total: number;
    }>({ key: "", records: [], total: 0 }),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [edit, setEdit] = useState<{ rec: RecordInfo; prop: PropInfo } | null>(
      null,
    );
  const timelineNode = useRef<ComponentRef<typeof ScrollView>>(null);
  const calendarList = useRef<FlashListRef<RecordInfo>>(null);
  const [limit, setLimit] = useState(60);
  const [timelineX] = useState(() => new Animated.Value(0));
  const {
    attach: calendarRef,
    measure: measureCalendar,
    onScroll: onCalendarScroll,
    onContentSizeChange: calendarContentSize,
    move: moveCalendar,
    stop: stopCalendar,
  } = useEdgeScroll(false);
  const {
    attach: timelineRef,
    measure: measureTimeline,
    onScroll: onTimelineScroll,
    onContentSizeChange: timelineContentSize,
    move: moveTimeline,
    stop: stopTimeline,
    scrollDelta: timelineDelta,
  } = useEdgeScroll(true);
  const targets = useRef(new Map<string, ComponentRef<typeof View>>());
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const targetAt = (x: number, y: number, found: (key: string) => void) => {
    targets.current.forEach((node, key) =>
      node.measureInWindow((left, top, w, h) => {
        if (x >= left && x < left + w && y >= top && y < top + h) found(key);
      }),
    );
  };
  const fields = props.filter((p) => p.type === "date"),
    start =
      fields.find(
        (p) =>
          p.id === (view.layout === "calendar" ? view.dateProp : view.start),
      ) ?? fields[0],
    end =
      view.end === null || view.end === "none"
        ? undefined
        : (fields.find((p) => p.id === view.end) ??
          fields.find((p) => p !== start));
  const weeks = useMemo(
    () => monthMatrix(cursor.getFullYear(), cursor.getMonth()),
    [cursor],
  );
  const from = weeks[0]![0]!,
    to = weeks.at(-1)!.at(-1)!;
  const source = JSON.stringify([
    databaseId,
    view.id,
    view.layout,
    view.filter,
    view.sort,
    search,
    start?.id,
    end?.id,
    toISO(from),
    toISO(to),
    undated,
  ]);
  const records = result.key === source ? result.records : [];
  const total = result.key === source ? result.total : 0;
  const more = () => {
    if (records.length < total) setLimit((n) => n + 60);
  };
  useEffect(() => {
    if (!start) return;
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      setLoading(true);
      setError("");

      const all: RecordInfo[] = [];
      try {
        for (let offset = 0; ; offset += 200) {
          const page = await session.client.queryRecords(databaseId, {
            search,
            filter: view.filter,
            sort: view.sort,
            offset,
            limit:
              view.layout === "calendar" && !undated
                ? 200
                : Math.min(200, Math.max(1, limit - offset)),
            dates: {
              start: start.id,
              end: view.layout === "timeline" ? end?.id : undefined,
              from: toISO(from),
              to: toISO(to),
              unscheduled: undated,
            },
          });
          if (!alive || !session.isCurrent()) return;
          all.push(...page.records);
          setResult({ key: source, records: [...all], total: page.total });
          if (
            !page.hasMore ||
            ((view.layout !== "calendar" || undated) && all.length >= limit)
          )
            break;
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [
    session,
    databaseId,
    search,
    view.filter,
    view.sort,
    view.layout,
    start,
    end?.id,
    from,
    to,
    undated,
    revision,
    limit,
    source,
  ]);
  useEffect(() => {
    if (start) onCreateContext({ [start.id]: day });
  }, [start, day, onCreateContext]);
  if (!start)
    return (
      <Pressable onPress={onAddDate} style={{ padding: 24 }}>
        <Text style={{ color: tokens.fg }}>此视图需要日期字段 · 点击新增</Text>
      </Pressable>
    );
  const header = (
    <View>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          padding: 8,
        }}
      >
        {[-1, 0, 1].map((n) => (
          <Pressable
            key={n}
            onPress={() => {
              const next = n
                ? new Date(cursor.getFullYear(), cursor.getMonth() + n, 1)
                : today();
              setCursor(next);
              setDay(toISO(next));
              const first = monthMatrix(
                next.getFullYear(),
                next.getMonth(),
              )[0]![0]!;
              requestAnimationFrame(() =>
                timelineNode.current?.scrollTo({
                  x: n ? 0 : Math.max(0, daysBetween(first, next) - 1) * 32,
                  animated: true,
                }),
              );
            }}
            style={{ padding: 10 }}
          >
            <Text style={{ color: tokens.fg }}>
              {n === -1 ? "‹" : n === 1 ? "›" : "今天"}
            </Text>
          </Pressable>
        ))}
        <Text style={{ color: tokens.fg }}>
          {cursor.getFullYear()} / {cursor.getMonth() + 1}
        </Text>
        <NativeMenu
          label={start.name}
          items={fields.map((p) => ({
            id: p.id,
            title: p.name,
            onPress: () =>
              onView(
                view.layout === "calendar"
                  ? { dateProp: p.id }
                  : { start: p.id },
              ),
          }))}
        />
        {view.layout === "timeline" && (
          <NativeMenu
            label={end ? `结束：${end.name}` : "里程碑"}
            items={[
              {
                id: "none",
                title: "无结束日期（里程碑）",
                onPress: () => onView({ end: null }),
              },
              ...fields
                .filter((p) => p.id !== start.id)
                .map((p) => ({
                  id: p.id,
                  title: p.name,
                  onPress: () => onView({ end: p.id }),
                })),
            ]}
          />
        )}
      </View>
      <Pressable onPress={() => setUndated(!undated)} style={{ padding: 10 }}>
        <Text style={{ color: tokens.fg }}>
          {undated ? "返回日期视图" : "未排期记录"}
        </Text>
      </Pressable>
      {!!error && <Text style={{ color: tokens.danger }}>{error}</Text>}
      {loading && <Text style={{ color: tokens.muted }}>加载中…</Text>}
      {!loading && !total && (
        <Text style={{ color: tokens.muted, paddingHorizontal: 10 }}>
          {undated ? "没有未排期记录" : "当前月份没有已排期记录"}
        </Text>
      )}
    </View>
  );
  const onDay = (d: Date) =>
    records.filter((r) => {
      const date = parseDate(r.cells[start.id]);
      return date && toISO(date) === toISO(d);
    });
  return (
    <View style={{ flex: 1 }}>
      {header}
      {undated ? (
        <FlashList
          data={records}
          onEndReached={more}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => setEdit({ rec: item, prop: start })}
              style={{ padding: 14 }}
            >
              <Text style={{ color: tokens.fg }}>
                {recordTitle(item, props)} · 添加日期
              </Text>
            </Pressable>
          )}
        />
      ) : view.layout === "calendar" ? (
        <FlashList
          ref={calendarList}
          onLoad={() => {
            // FlashList 2 types still name the pre-0.88 ScrollView component as its instance.
            calendarRef(
              (calendarList.current?.getNativeScrollRef() ??
                null) as unknown as ComponentRef<typeof ScrollView> | null,
            );
            measureCalendar();
          }}
          onScroll={onCalendarScroll}
          onContentSizeChange={calendarContentSize}
          scrollEventThrottle={16}
          data={records.filter((r) => {
            const d = parseDate(r.cells[start.id]);
            return d && toISO(d) === day;
          })}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => (
            <Pressable onPress={() => onOpen(item.id)} style={{ padding: 14 }}>
              <Text style={{ color: tokens.fg }}>
                {recordTitle(item, props)}
              </Text>
            </Pressable>
          )}
          ListHeaderComponent={
            <View>
              <View style={{ flexDirection: "row" }}>
                {["一", "二", "三", "四", "五", "六", "日"].map((d) => (
                  <Text
                    key={d}
                    style={{
                      width: "14.2857%",
                      textAlign: "center",
                      color: tokens.muted,
                    }}
                  >
                    {d}
                  </Text>
                ))}
              </View>
              {weeks.map((week, i) => (
                <View key={i} style={{ flexDirection: "row" }}>
                  {week.map((d) => (
                    <Pressable
                      ref={(node) => {
                        if (node) targets.current.set(toISO(d), node);
                        else targets.current.delete(toISO(d));
                      }}
                      key={toISO(d)}
                      onPress={() => {
                        setDay(toISO(d));
                        setShowDay(true);
                      }}
                      style={{
                        width: "14.2857%",
                        minHeight: 90,
                        padding: 3,
                        borderWidth: 0.5,
                        borderColor: tokens.line,
                        backgroundColor:
                          day === toISO(d) || dropDay === toISO(d)
                            ? tokens.accentSoft
                            : tokens.bg,
                      }}
                    >
                      <Text style={{ color: tokens.fg }}>{d.getDate()}</Text>
                      {onDay(d)
                        .slice(0, 3)
                        .map((r) => (
                          <DragItem
                            key={r.id}
                            onMove={(p) => {
                              moveCalendar(p.y);
                              targetAt(p.x, p.y, setDropDay);
                            }}
                            onFinish={() => {
                              setDropDay(null);
                              stopCalendar();
                            }}
                            onDrop={(p) =>
                              targetAt(p.x, p.y, (day) => {
                                void onSave(r.id, start, day);
                              })
                            }
                          >
                            <Pressable onPress={() => onOpen(r.id)}>
                              <Text
                                numberOfLines={1}
                                style={{ fontSize: 11, color: tokens.fg }}
                              >
                                {recordTitle(r, props)}
                              </Text>
                            </Pressable>
                          </DragItem>
                        ))}
                      {onDay(d).length > 3 && (
                        <Text style={{ color: tokens.muted, fontSize: 11 }}>
                          +{onDay(d).length - 3}
                        </Text>
                      )}
                    </Pressable>
                  ))}
                </View>
              ))}
              <Pressable
                onPress={() => onCreate({ [start.id]: day })}
                style={{ padding: 14 }}
              >
                <Text style={{ color: tokens.fg }}>＋ {day} 新建记录</Text>
              </Pressable>
            </View>
          }
        />
      ) : (
        <Animated.ScrollView
          ref={(node) => {
            timelineNode.current = node;
            timelineRef(node);
          }}
          onLayout={measureTimeline}
          onContentSizeChange={timelineContentSize}
          horizontal
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { x: timelineX } } }],
            { useNativeDriver: true, listener: onTimelineScroll },
          )}
          scrollEventThrottle={16}
        >
          <View style={{ width: 140 + weeks.length * 7 * 32, flex: 1 }}>
            <View style={{ flexDirection: "row", height: 44 }}>
              <Animated.View
                style={{
                  width: 140,
                  zIndex: 2,
                  backgroundColor: tokens.bg,
                  transform: [{ translateX: timelineX }],
                }}
              >
                <Text style={{ color: tokens.fg, padding: 8 }}>记录</Text>
              </Animated.View>
              {weeks.flat().map((d) => (
                <Text key={toISO(d)} style={{ width: 32, color: tokens.muted }}>
                  {d.getDate()}
                </Text>
              ))}
            </View>
            <FlashList
              data={records}
              onEndReached={more}
              keyExtractor={(r) => r.id}
              renderItem={({ item }) => {
                const s = parseDate(item.cells[start.id])!,
                  e = end ? parseDate(item.cells[end.id]) : null;
                const span = timelineSpan(s, e, from, to);
                return (
                  <View
                    style={{
                      height: 48,
                      flexDirection: "row",
                      borderBottomWidth: 1,
                      borderColor: tokens.line,
                    }}
                  >
                    <Animated.View
                      style={{
                        width: 140,
                        zIndex: 5,
                        backgroundColor: tokens.bg,
                        transform: [{ translateX: timelineX }],
                      }}
                    >
                      <Pressable
                        onPress={() => onOpen(item.id)}
                        style={{ padding: 8 }}
                      >
                        <Text numberOfLines={1} style={{ color: tokens.fg }}>
                          {recordTitle(item, props)}
                        </Text>
                      </Pressable>
                    </Animated.View>
                    <View
                      style={{
                        marginLeft: span.left * 32,
                        width: span.days * 32,
                        height: 48,
                      }}
                    >
                      <DragItem
                        onMove={(p) => moveTimeline(p.x)}
                        onFinish={stopTimeline}
                        onDrop={(p) => {
                          const delta = Math.round(
                            (p.dx + timelineDelta()) / 32,
                          );
                          if (delta)
                            void onSaveCells(
                              item.id,
                              moveDates(start.id, s, end?.id, e, delta),
                            );
                        }}
                      >
                        <Pressable
                          accessibilityLabel="编辑日期；长按拖动改期"
                          onPress={() => {
                            if (selectedTask === item.id)
                              setEdit({ rec: item, prop: start });
                            else setSelectedTask(item.id);
                          }}
                          style={{
                            height: 32,
                            marginTop: 8,
                            borderRadius: 6,
                            backgroundColor: tokens.accentSoft,
                            paddingHorizontal: span.milestone ? 0 : 12,
                          }}
                        >
                          <Text
                            numberOfLines={1}
                            style={{
                              color: tokens.fg,
                              paddingVertical: 6,
                              textAlign: span.milestone ? "center" : "left",
                            }}
                          >
                            {span.milestone ? "◆" : recordTitle(item, props)}
                          </Text>
                        </Pressable>
                      </DragItem>
                      {end && selectedTask === item.id && (
                        <>
                          <View
                            style={{ position: "absolute", left: -8, top: 4 }}
                          >
                            <DragItem
                              onMove={(p) => moveTimeline(p.x)}
                              onFinish={stopTimeline}
                              onDrop={(p) => {
                                void onSave(
                                  item.id,
                                  start,
                                  resizeDate(
                                    s,
                                    e,
                                    "start",
                                    Math.round((p.dx + timelineDelta()) / 32),
                                  ),
                                );
                              }}
                            >
                              <Pressable
                                accessibilityLabel="调整开始日期"
                                onPress={() =>
                                  setEdit({ rec: item, prop: start })
                                }
                                style={{
                                  width: 24,
                                  height: 40,
                                  alignItems: "center",
                                  justifyContent: "center",
                                }}
                              >
                                <Text style={{ color: tokens.accent }}>┃</Text>
                              </Pressable>
                            </DragItem>
                          </View>
                          <View
                            style={{ position: "absolute", right: -8, top: 4 }}
                          >
                            <DragItem
                              onMove={(p) => moveTimeline(p.x)}
                              onFinish={stopTimeline}
                              onDrop={(p) => {
                                void onSave(
                                  item.id,
                                  end,
                                  resizeDate(
                                    s,
                                    e,
                                    "end",
                                    Math.round((p.dx + timelineDelta()) / 32),
                                  ),
                                );
                              }}
                            >
                              <Pressable
                                accessibilityLabel="调整结束日期"
                                onPress={() =>
                                  setEdit({ rec: item, prop: end })
                                }
                                style={{
                                  width: 24,
                                  height: 40,
                                  alignItems: "center",
                                  justifyContent: "center",
                                }}
                              >
                                <Text style={{ color: tokens.accent }}>┃</Text>
                              </Pressable>
                            </DragItem>
                          </View>
                        </>
                      )}
                    </View>
                  </View>
                );
              }}
            />
          </View>
        </Animated.ScrollView>
      )}
      {showDay && (
        <NativeSheet isPresented onDismiss={() => setShowDay(false)}>
          <RNHostView matchContents={{ vertical: true }}>
            <View
              style={{
                height: screenHeight * 0.65,
                backgroundColor: tokens.surface,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: 8,
                }}
              >
                <Text style={{ color: tokens.fg, fontSize: 18 }}>
                  {day} ·{" "}
                  {
                    records.filter((r) => {
                      const d = parseDate(r.cells[start.id]);
                      return d && toISO(d) === day;
                    }).length
                  }{" "}
                  条
                </Text>
                <NativeButton variant="text" onPress={() => setShowDay(false)}>
                  完成
                </NativeButton>
              </View>
              <NativeButton
                variant="text"
                onPress={() => {
                  setShowDay(false);
                  onCreate({ [start.id]: day });
                }}
              >
                ＋ 新建记录
              </NativeButton>
              <FlashList
                data={records.filter((r) => {
                  const d = parseDate(r.cells[start.id]);
                  return d && toISO(d) === day;
                })}
                keyExtractor={(r) => r.id}
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() => {
                      setShowDay(false);
                      onOpen(item.id);
                    }}
                    style={{ padding: 14 }}
                  >
                    <Text style={{ color: tokens.fg }}>
                      {recordTitle(item, props)}
                    </Text>
                  </Pressable>
                )}
              />
            </View>
          </RNHostView>
        </NativeSheet>
      )}
      {edit && (
        <CellSheet
          key={edit.rec.id + edit.prop.id}
          prop={edit.prop}
          value={edit.rec.cells[edit.prop.id]}
          onClose={() => setEdit(null)}
          onSave={(v) => {
            if (view.layout === "timeline" && end && v) {
              const s = parseDate(
                edit.prop.id === start.id ? v : edit.rec.cells[start.id],
              );
              const e = parseDate(
                edit.prop.id === end.id ? v : edit.rec.cells[end.id],
              );
              if (s && e && e < s) throw new Error("结束日期不能早于开始日期");
            }
            return onSave(edit.rec.id, edit.prop, v);
          }}
        />
      )}
    </View>
  );
}
