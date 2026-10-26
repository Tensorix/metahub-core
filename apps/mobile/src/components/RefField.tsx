import { Checkbox, RNHostView } from "@expo/ui";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { NativeSheet } from "@/components/native/NativeSheet";
import { useSheetContentHeight } from "@/components/native/useSheetContentHeight";
import { NativeHost } from "@/components/native/NativeHost";
import { NativeButton } from "@/components/native/NativeButton";
import { RecordTextInput } from "@/components/RecordTextInput";
import { useApiData } from "@/lib/api/hooks";
import type { PropInfo } from "@/lib/api/sdk";
import { useSession } from "@/lib/auth/session";
import { recordTitle } from "@/lib/format";
import { useTheme } from "@/lib/theme";

export interface Candidate {
  id: string;
  title: string;
  missing?: boolean;
}
export const referenceIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
/** Selected labels are resolved by ID, independently of candidate paging. */
export function useRefData(
  props: PropInfo[],
  cells: Record<string, unknown> = {},
) {
  const { client } = useSession();
  const key = JSON.stringify(
    props
      .filter((p) => p.type === "relation" || p.type === "doc")
      .map((p) => ({
        id: p.id,
        kind: p.type === "doc" ? ("document" as const) : ("record" as const),
        databaseId:
          p.type === "relation"
            ? (p.config?.database as string | undefined)
            : undefined,
        ids: referenceIds(cells[p.id]),
      })),
  );
  const requests = useMemo(
    () =>
      JSON.parse(key) as {
        id: string;
        kind: "document" | "record";
        databaseId?: string;
        ids: string[];
      }[],
    [key],
  );
  const fetchAll = useCallback(
    async () =>
      new Map(
        await Promise.all(
          requests.map(
            async (p) =>
              [
                p.id,
                (await client.referenceSummaries(p)).map((c) => ({
                  id: c.id,
                  title: c.missing
                    ? "目标已删除或不可用 · " + c.id.slice(0, 12)
                    : c.title || "未命名",
                  missing: c.missing,
                })),
              ] as const,
          ),
        ),
      ),
    [client, requests],
  );
  const { data, ...state } = useApiData(fetchAll);
  const candidates = useCallback(
    (p: PropInfo): Candidate[] => data?.get(p.id) ?? [],
    [data],
  );
  const titleOf = useCallback(
    (p: PropInfo, id: string) =>
      candidates(p).find((c) => c.id === id)?.title ?? id.slice(0, 12) + "…",
    [candidates],
  );
  const missing = useCallback(
    (p: PropInfo, id: string) =>
      candidates(p).find((c) => c.id === id)?.missing ?? false,
    [candidates],
  );
  const refDisplay = useCallback(
    (p: PropInfo, value: unknown) =>
      referenceIds(value)
        .map((id) => titleOf(p, id))
        .join("、") || "尚未关联",
    [titleOf],
  );
  return { ...state, candidates, titleOf, missing, refDisplay };
}

/** Selection never opens a target. The record's separate Open buttons own navigation. */
export function RefPickerSheet({
  prop,
  candidates = [],
  initialSelected,
  onChange,
  onClose,
  onRetry,
}: {
  prop: PropInfo;
  candidates?: Candidate[];
  initialSelected: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
}) {
  const { tokens } = useTheme();
  const { client } = useSession();
  const sheetHeight = useSheetContentHeight(600, 0.7);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(initialSelected);
  const latest = useRef(selected);
  const [query, setQuery] = useState("");
  const target =
    prop.type === "relation"
      ? (prop.config?.database as string | undefined)
      : "docs";
  const fetchPage = useCallback(async () => {
    if (prop.type === "doc") {
      const result = await client.queryDocuments({
        search: query,
        offset,
        limit: 60,
      });
      return {
        ...result,
        candidates: result.documents.map((d) => ({
          id: d.id,
          title: d.title || "未命名",
        })),
      };
    }
    if (!target)
      return { candidates: [] as Candidate[], hasMore: false, total: 0 };
    const [result, props] = await Promise.all([
      client.queryRecords(target, { search: query, offset, limit: 60 }),
      client.listProperties(target),
    ]);
    return {
      ...result,
      candidates: result.records.map((r) => ({
        id: r.id,
        title: recordTitle(r, props),
      })),
    };
  }, [client, prop.type, target, query, offset]);
  const page = useApiData(fetchPage);
  const toggle = (id: string) => {
    const next = latest.current.includes(id)
      ? latest.current.filter((s) => s !== id)
      : [...latest.current, id];
    latest.current = next;
    setSelected(next);
    onChange(next);
  };
  const close = () => {
    Keyboard.dismiss();
    onClose();
  };
  return (
    <NativeSheet isPresented onDismiss={close} testID="reference-picker">
      <RNHostView matchContents={{ vertical: true }}>
        <View
          style={{
            height: sheetHeight,
            width: "100%",
            backgroundColor: tokens.surface,
            gap: 8,
          }}
        >
          <View style={styles.head}>
            <Text
              selectable
              numberOfLines={1}
              style={{
                color: tokens.fg,
                fontSize: 18,
                fontWeight: "600",
                flex: 1,
              }}
            >
              {prop.name}
            </Text>
            <NativeButton onPress={close}>完成</NativeButton>
          </View>
          <FlatList
            style={{ flex: 1 }}
            data={[
              ...candidates.filter((c) => c.missing && selected.includes(c.id)),
              ...(page.data?.candidates ?? []),
            ]}
            keyExtractor={(c) => c.id}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="interactive"
            contentInsetAdjustmentBehavior="automatic"
            renderItem={({ item }) => (
              <View style={[styles.row, { borderColor: tokens.line }]}>
                <NativeHost matchContents style={{ flex: 1 }}>
                  <Checkbox
                    label={item.title}
                    value={selected.includes(item.id)}
                    onValueChange={() => toggle(item.id)}
                  />
                </NativeHost>
              </View>
            )}
            ListHeaderComponent={
              <View style={{ gap: 8 }}>
                <NativeHost matchContents>
                  <RecordTextInput
                    text={query}
                    placeholder="搜索关联项"
                    onChangeText={(value) => {
                      setQuery(value);
                      setOffset(0);
                    }}
                  />
                </NativeHost>
                <Text selectable style={{ color: tokens.muted }}>
                  已选 {selected.length} 项 · 点按选项以添加或移除
                </Text>
                {page.loading ? <ActivityIndicator /> : null}
                {page.error ? (
                  <NativeButton
                    onPress={() => {
                      void page.refetch();
                      onRetry?.();
                    }}
                  >
                    加载失败，重试
                  </NativeButton>
                ) : null}
                {candidates.some((c) => c.missing) ? (
                  <Text selectable style={{ color: tokens.muted }}>
                    部分已选目标已删除；仍保留其引用，可在字段中移除。
                  </Text>
                ) : null}
              </View>
            }
            ListFooterComponent={
              <View style={styles.head}>
                <NativeButton
                  disabled={!offset || page.loading}
                  onPress={() => setOffset(Math.max(0, offset - 60))}
                >
                  上一页
                </NativeButton>
                <Text style={{ color: tokens.muted }}>
                  第 {Math.floor(offset / 60) + 1} 页
                </Text>
                <NativeButton
                  disabled={!page.data?.hasMore || page.loading}
                  onPress={() => setOffset(offset + 60)}
                >
                  下一页
                </NativeButton>
              </View>
            }
            ListEmptyComponent={
              !page.loading && !page.error ? (
                <Text style={{ padding: 20, color: tokens.muted }}>
                  {!target
                    ? "该关联列未配置目标数据库"
                    : query
                      ? "没有匹配项"
                      : "没有可选项"}
                </Text>
              ) : null
            }
          />
        </View>
      </RNHostView>
    </NativeSheet>
  );
}
const styles = StyleSheet.create({
  head: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  row: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
