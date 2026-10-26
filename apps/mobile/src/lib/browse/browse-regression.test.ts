import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../../../../src/core/schema-init.ts";
import { createReplicaService } from "../../../../../src/core/replica/service.ts";
import {
  emptyView,
  normalizeViews,
} from "../../../../../src/shared/views/model.ts";
import { findManualNeighbor, mergeView, validPageOffset } from "./management";
const handles: Database[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});
function fixture() {
  const db = new Database(":memory:");
  handles.push(db);
  initSchema(db);
  const service = createReplicaService(db);
  const database = service.commands.createDatabase({ name: "Review" });
  const group = service.commands.addProperty(database.id, {
    name: "Status",
    type: "select",
    config: { options: ["A", "B"] },
  });
  const records = Array.from({ length: 125 }, (_, i) =>
    service.commands.createRecord(database.id, {
      [group.id]: i % 2 ? "B" : "A",
    }),
  );
  return { service, database, group, records };
}

test("board neighbor crosses global pages but stays in the visible column and preserves every record", async () => {
  const { service, database, group, records } = fixture();
  const current = records[60]!;
  let pages = 0;
  const anchor = await findManualNeighbor(
    (start) => {
      pages++;
      return service.client.queryRecords(database.id, {
        offset: start,
        limit: 60,
      });
    },
    current.id,
    "up",
    (record) => record.cells[group.id] === "A",
  );
  expect(anchor?.id).toBe(records[58]!.id);
  expect(pages).toBe(2);
  await service.client.moveRecord(current.id, anchor!.id, "before");
  const all = service.commands.listRecords(database.id);
  expect(all).toHaveLength(125);
  expect(new Set(all.map((r) => r.id)).size).toBe(125);
  const column = all.filter((r) => r.cells[group.id] === "A").map((r) => r.id);
  expect(column.indexOf(current.id) + 1).toBe(column.indexOf(anchor!.id));
  expect(
    all.every(
      (r) =>
        r.cells[group.id] ===
        records.find((original) => original.id === r.id)!.cells[group.id],
    ),
  ).toBe(true);
});

test("removing the entire last page recovers the previous valid canonical page", async () => {
  const { service, database, records } = fixture();
  for (const record of records.slice(120))
    await service.client.deleteRecord(record.id);
  const emptied = await service.client.queryRecords(database.id, {
    offset: 120,
    limit: 60,
  });
  expect(emptied.records).toHaveLength(0);
  expect(emptied.total).toBe(120);
  const offset = validPageOffset(120, emptied.total, 60);
  expect(offset).toBe(60);
  const recovered = await service.client.queryRecords(database.id, {
    offset,
    limit: 60,
  });
  expect(recovered.records).toHaveLength(60);
  expect(recovered.hasMore).toBe(false);
});

test("saving a stale view draft preserves newer opaque config at every edited nesting level", async () => {
  const { service, database, group } = fixture();
  const original = {
    ...emptyView("board", "Initial", "main"),
    plugin: { version: 1 },
    group: group.id,
    sort: [{ prop: group.id, desc: false, plugin: 1 }],
    filter: {
      op: "and" as const,
      plugin: 1,
      rules: [{ id: "f", prop: group.id, cond: "is", value: "A", plugin: 1 }],
    },
  };
  const remote = {
    ...original,
    plugin: { version: 2 },
    sort: [{ ...original.sort[0]!, plugin: 2 }],
    filter: {
      ...original.filter,
      plugin: 2,
      rules: [{ ...original.filter.rules[0]!, plugin: 2 }],
    },
  };
  const future = { id: "future", layout: "gallery", plugin: 3 };
  service.commands.updateDatabase(database.id, {
    meta: { views: [remote, future], other: "keep" },
  });
  const latest = (await service.client.listDatabases()).find(
    (d) => d.id === database.id,
  )!;
  const draft = { ...normalizeViews([original])[0]!, name: "Local rename" };
  await service.client.updateDatabase(database.id, {
    meta: { views: mergeView(latest.meta?.views, [], draft) },
  });
  const saved = service.commands
    .listDatabases()
    .find((d) => d.id === database.id)!;
  const views = saved.meta!.views as (typeof remote)[];
  expect(views[0]!.name).toBe("Local rename");
  expect(views[0]!.plugin).toEqual({ version: 2 });
  expect(views[0]!.sort[0]!.plugin).toBe(2);
  expect(views[0]!.filter.plugin).toBe(2);
  expect(views[0]!.filter.rules[0]!.plugin).toBe(2);
  expect(views[1] as unknown).toEqual(future);
  expect(saved.meta!.other).toBe("keep");
});

test("a workspace switch cancels multi-page neighbor traversal before returning an anchor", async () => {
  let current = true;
  await expect(
    findManualNeighbor(
      async () => {
        current = false;
        return { records: [{ id: "target" }], hasMore: false };
      },
      "target",
      "up",
      () => true,
      () => current,
    ),
  ).rejects.toThrow("工作区已切换");
});
