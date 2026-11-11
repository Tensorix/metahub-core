/** Explicit Release-only fixture workspace. Never loads credentials or starts sync. */
import { useEffect, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { openDatabaseSync } from "expo-sqlite";
import { ExpoDriver, nativeSqliteOpenOptions } from "../replica/expo-driver";
import { initSchema } from "../../../../../src/core/schema-init";
import { createReplicaService } from "../../../../../src/core/replica/service";
import { defaultViews, emptyView } from "../../../../../src/shared/views/model";
import { StaticSessionProvider, type Session } from "../auth/session";
import { initializeNativeSyncRuntime } from "../sync/runtime";
const disabled = async () => {
  throw new Error(
    "External operations disabled in isolated database benchmark",
  );
};
let setup: Promise<Session> | undefined;
async function prepare() {
  await initializeNativeSyncRuntime();
  const sqlite = openDatabaseSync(
      "database-opening-benchmark-v1.db",
      nativeSqliteOpenOptions,
    ),
    db = new ExpoDriver(sqlite);
  initSchema(db);
  const service = createReplicaService(db);
  for (const count of [16, 10000, 50000]) {
    const id = "db_benchmark_" + count;
    if (
      (
        db
          .query("SELECT count(*) AS n FROM records WHERE database_id=?")
          .get(id) as { n: number }
      ).n === count
    )
      continue;
    db.query("DELETE FROM records WHERE database_id=?").run(id);
    db.query("DELETE FROM properties WHERE database_id=?").run(id);
    const fields = Array.from({ length: 50 }, (_, i) => ({
      id: `p_${count}_${i}`,
      name: ["标题", "数值", "状态", "日期"][i] ?? `字段 ${i}`,
      type: i === 1 ? "number" : i === 2 ? "select" : i === 3 ? "date" : "text",
    }));
    const views = defaultViews();
    views.push({
      ...emptyView("table", "复杂筛选排序", "v_complex"),
      filter: {
        op: "and",
        rules: [{ id: "n", prop: fields[1]!.id, cond: "ge", value: 3 }],
      },
      sort: [{ prop: fields[1]!.id, desc: true }],
    });
    db.query(
      "INSERT OR REPLACE INTO databases(id,name,meta) VALUES(?,?,?)",
    ).run(id, `性能测试 ${count} × 50`, JSON.stringify({ views }));
    for (const [i, p] of fields.entries())
      db.query(
        "INSERT INTO properties(id,database_id,name,type,config,position) VALUES(?,?,?,?,?,?)",
      ).run(
        p.id,
        id,
        p.name,
        p.type,
        JSON.stringify(i === 2 ? { options: ["待办", "进行中", "完成"] } : {}),
        i,
      );
    const insert = db.query(
      "INSERT INTO records(id,database_id,order_key,data) VALUES(?,?,?,?)",
    );
    for (let start = 0; start < count; start += 200) {
      db.transaction(() => {
        for (let i = start; i < Math.min(count, start + 200); i++)
          insert.run(
            `rec_benchmark_${count}_${i}`,
            id,
            String(i).padStart(8, "0"),
            JSON.stringify(
              Object.fromEntries(
                fields.map((p, j) => [
                  p.id,
                  j === 1
                    ? i % 97
                    : j === 2
                      ? ["待办", "进行中", "完成"][i % 3]
                      : j === 3
                        ? i % 5
                          ? "2026-11-" + String((i % 28) + 1).padStart(2, "0")
                          : null
                        : `测试记录 ${i} 字段 ${j}`,
                ]),
              ),
            ),
          );
      })();
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  const noEvents = () => () => {};
  const session = {
    id: 999,
    workspaceId: "database-opening-benchmark",
    creds: { baseUrl: "https://benchmark.invalid", token: "" },
    client: service.client,
    api: service.client,
    replica: {
      db,
      sqlite,
      service,
      name: "database-opening-benchmark-v1.db",
      close: () => {},
    },
    sync: {
      status: { connected: false, lastSyncAt: null, pendingPush: 0 },
      onStatus: noEvents,
    },
    live: { connected: false, onChange: service.onChange, onStatus: noEvents },
    attachments: {},
    siteResources: {
      subscribe: noEvents,
      snapshot: () => 0,
      missing: new Set(),
    },
    onSiteSessionEnd: noEvents,
    authInvalid: false,
    isCurrent: () => true,
    syncNow: disabled,
    dispose: async () => {},
  } as unknown as Session;
  console.info("[database-benchmark] fixtures-ready");
  return session;
}
export function DatabaseBenchmarkWorkspace({
  children,
}: {
  children: ReactNode;
}) {
  const [session, setSession] = useState<Session | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void (setup ??= prepare()).then(
      (s) => {
        if (live) setSession(s);
      },
      (e) => {
        if (live) setError(String(e));
      },
    );
    return () => {
      live = false;
    };
  }, []);
  if (!session)
    return (
      <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
        <Text>{error || "正在准备隔离性能测试数据…"}</Text>
      </View>
    );
  return (
    <StaticSessionProvider session={session}>{children}</StaticSessionProvider>
  );
}
