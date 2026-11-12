import { useCallback, useMemo, useRef, useState } from "react";
import { Keyboard } from "react-native";
import { SelectionSheet } from "@/components/native/SelectionSheet";
import { useApiData } from "@/lib/api/hooks";
import type { PropInfo } from "@/lib/api/sdk";
import { useSession } from "@/lib/auth/session";
import { recordTitle } from "@/lib/format";

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
  error,
  busy = false,
  onOpen,
}: {
  prop: PropInfo;
  candidates?: Candidate[];
  initialSelected: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  busy?: boolean;
  onOpen?: (id: string) => void;
}) {
  const { client } = useSession();
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
    if (busy) return;
    Keyboard.dismiss();
    onClose();
  };
  return (
    <SelectionSheet
      title={prop.name}
      onClose={close}
      busy={busy}
      testID="reference-picker"
      search={{
        value: query,
        placeholder: "搜索关联项",
        onChange: (value) => {
          setQuery(value);
          setOffset(0);
        },
      }}
      summary={`已选 ${selected.length} 项`}
      onSelect={toggle}
      onOpen={onOpen}
      items={(
        [
          ...candidates.filter((c) => c.missing && selected.includes(c.id)),
          ...(page.data?.candidates ?? []),
        ] as Candidate[]
      ).map((item) => ({
        id: item.id,
        title: item.title,
        selected: selected.includes(item.id),
        canOpen: !!onOpen && !item.missing,
      }))}
      loading={page.loading}
      notices={[
        ...(error
          ? [
              {
                text: error.message,
                action: onRetry
                  ? { label: "重试保存", onPress: onRetry }
                  : undefined,
              },
            ]
          : []),
        ...(page.error
          ? [
              {
                text: "加载失败",
                action: {
                  label: "重试",
                  onPress: () => {
                    void page.refetch();
                    onRetry?.();
                  },
                },
              },
            ]
          : []),
        ...(candidates.some((c) => c.missing)
          ? [{ text: "部分已选目标已删除；仍保留其引用，可在字段中移除。" }]
          : []),
      ]}
      pagination={
        offset > 0 || page.data?.hasMore
          ? {
              page: Math.floor(offset / 60) + 1,
              hasPrevious: offset > 0,
              hasNext: !!page.data?.hasMore,
              onPrevious: () => setOffset(Math.max(0, offset - 60)),
              onNext: () => setOffset(offset + 60),
            }
          : undefined
      }
      empty={
        page.error
          ? undefined
          : !target
            ? "该关联列未配置目标数据库"
            : query
              ? "没有匹配项"
              : "没有可选项"
      }
    />
  );
}
