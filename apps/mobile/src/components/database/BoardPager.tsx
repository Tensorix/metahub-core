import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { BoardView } from "../BoardView";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import type { RecordInfo } from "@/lib/api/sdk";
import type { ViewDef } from "../../../../../src/shared/views/model";
type Props = Omit<Parameters<typeof BoardView>[0], "records"> & {
  databaseId: string;
  view: ViewDef;
  search: string;
  revision: number;
};
export function BoardPager({
  databaseId,
  view,
  search,
  revision,
  ...props
}: Props) {
  const session = useSession(),
    { tokens } = useTheme(),
    [limits, setLimits] = useState<Record<string, number>>({}),
    [data, setData] = useState<{
      records: RecordInfo[];
      totals: Record<string, number>;
    }>({ records: [], totals: {} }),
    [error, setError] = useState("");
  const key = JSON.stringify([
    databaseId,
    view.id,
    view.filter,
    view.sort,
    search,
    props.groupProp.id,
    props.groupProp.config?.options,
    revision,
    limits,
  ]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const records: RecordInfo[] = [],
          totals: Record<string, number> = {};
        for (const group of [
          ...(props.groupProp.config?.options ?? []),
          null,
        ]) {
          const groupKey = group ?? "__ungrouped__",
            limit = limits[groupKey] ?? 60;
          for (let offset = 0; offset < limit; offset += 200) {
            const result = await session.client.queryRecords(databaseId, {
              search,
              filter: view.filter,
              sort: view.sort,
              group: { prop: props.groupProp.id, value: group },
              limit: Math.min(200, limit - offset),
              offset,
            });
            if (!alive || !session.isCurrent()) return;
            records.push(...result.records);
            totals[groupKey] = result.total;
            if (!result.hasMore) break;
          }
        }
        if (alive) {
          setData({ records, totals });
          setError("");
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
    // key captures the persisted view and every per-column paging input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, session]);
  return (
    <View style={{ flex: 1 }}>
      {!!error && <Text style={{ color: tokens.danger }}>{error}</Text>}
      <BoardView
        {...props}
        records={data.records}
        totals={data.totals}
        onMore={(group) => {
          const k = group ?? "__ungrouped__";
          if ((limits[k] ?? 60) < (data.totals[k] ?? 0))
            setLimits((prev) => ({ ...prev, [k]: (prev[k] ?? 60) + 60 }));
        }}
      />
    </View>
  );
}
