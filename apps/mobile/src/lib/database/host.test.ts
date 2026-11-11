import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../../../../src/core/schema-init";
import { createReplicaService } from "../../../../../src/core/replica/service";
import { createDatabaseHost } from "./host";
function fixture() {
  const db = new Database(":memory:");
  initSchema(db);
  const service = createReplicaService(db);
  const database = service.commands.createDatabase({ name: "test" });
  const prop = service.commands.addProperty(database.id, {
    name: "Title",
    type: "text",
  });
  const row = service.commands.createRecord(database.id, {
    [prop.id]: "Before",
  });
  let current = true;
  const host = createDatabaseHost(service, database.id, () => current, {
    openRecord: () => {},
    clipboardRead: async () => "",
    clipboardWrite: async () => {},
  });
  return {
    db,
    service,
    database,
    prop,
    row,
    host,
    leave: () => {
      current = false;
    },
  };
}
test("draft ACK is persistent, revisions cannot overwrite new input, flush shares native writer", async () => {
  const f = fixture();
  try {
    expect(
      await f.host.call("checkpoint", [f.row.id, f.prop.id, "你好", 2]),
    ).toEqual({ revision: 2 });
    await f.host.call("checkpoint", [f.row.id, f.prop.id, "old", 1]);
    expect(f.service.drafts.readFields(f.row.id)[f.prop.id]?.value).toBe(
      "你好",
    );
    await f.host.flush();
    expect(f.service.commands.getRecord(f.row.id).cells[f.prop.id]).toBe(
      "你好",
    );
    f.leave();
    await expect(
      f.host.call("checkpoint", [f.row.id, f.prop.id, "wrong", 3]),
    ).rejects.toThrow("工作区");
  } finally {
    f.service.dispose();
    f.db.close();
  }
});
test("host overlays restored drafts on bounded pages and persists device preferences", async () => {
  const f = fixture();
  try {
    f.service.drafts.checkpointField(f.row.id, f.prop.id, {
      value: "恢复内容",
      status: "draft",
    });
    const index = (await f.host.call("openRecordQuery", [
      f.database.id,
      {},
    ])) as { id: string };
    const page = (await f.host.call("readRecordQuery", [
      index.id,
      0,
      100,
      null,
    ])) as any;
    expect(page.records[0].cells[f.prop.id]).toBe("恢复内容");
    await f.host.call("preference", ["mh.db.view." + f.database.id, "board"]);
    expect(f.host.preferences()["mh.db.view." + f.database.id]).toBe("board");
    await expect(f.host.call("eval", ["arbitrary"])).rejects.toThrow(
      "暂不支持",
    );
  } finally {
    f.service.dispose();
    f.db.close();
  }
});
test("reading an ordinary page does one draft batch lookup and no per-record draft reads", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 120; i++)
      f.service.commands.createRecord(f.database.id, {
        [f.prop.id]: String(i),
      });
    let reads = 0,
      batches = 0;
    const read = f.service.drafts.readFields,
      batch = f.service.drafts.recordsWithDrafts;
    f.service.drafts.readFields = (...args) => {
      reads++;
      return read(...args);
    };
    f.service.drafts.recordsWithDrafts = (...args) => {
      batches++;
      return batch(...args);
    };
    const index = (await f.host.call("openRecordQuery", [
      f.database.id,
      { protocol: 2 },
    ])) as { id: string };
    const page = (await f.host.call("readRecordQuery", [
      index.id,
      0,
      100,
    ])) as any;
    expect(page.records).toHaveLength(100);
    expect(reads).toBe(0);
    expect(batches).toBe(1);
    await f.host.releaseQueries();
    await expect(f.service.client.readRecordQuery(index.id)).rejects.toThrow(
      "stale",
    );
  } finally {
    f.service.dispose();
    f.db.close();
  }
});
test("unrelated database changes preserve a query; edits in its database invalidate it", async () => {
  const f = fixture();
  try {
    const other = await f.service.client.createDatabase({ name: "Other" });
    const index = await f.service.client.openRecordQuery(f.database.id, {
      protocol: 2,
    });
    const changes: any[] = [];
    f.service.onChange((change) => changes.push(change));
    await f.service.client.createRecord(other.id, {});
    expect(changes.at(-1).databaseIds).toEqual([other.id]);
    expect(
      (await f.service.client.readRecordQuery(index.id)).records,
    ).toHaveLength(1);
    await f.service.client.updateRecord(f.row.id, { [f.prop.id]: "Changed" });
    expect(changes.at(-1).databaseIds).toEqual([f.database.id]);
    await expect(f.service.client.readRecordQuery(index.id)).rejects.toThrow(
      "stale",
    );
  } finally {
    f.service.dispose();
    f.db.close();
  }
});
test("opening coordinator shares the prepared query and discards stale prefetched data", async () => {
  const f = fixture();
  try {
    let opens = 0;
    const open = f.service.client.openRecordQuery;
    f.service.client.openRecordQuery = (...args) => {
      opens++;
      return open(...args);
    };
    const metadata = await f.host.prepareOpening("table");
    expect(metadata.db.id).toBe(f.database.id);
    const { databaseViewQuery } =
      await import("../../../../../src/shared/views/database-view-query");
    const { defaultViews } =
      await import("../../../../../src/shared/views/model");
    const query = {
      ...databaseViewQuery(defaultViews()[0]!, metadata.props),
      protocol: 2,
    };
    const first = (await f.host.call("openRecordQuery", [
      f.database.id,
      query,
    ])) as { id: string };
    expect(opens).toBe(1);
    expect(
      ((await f.host.call("readRecordQuery", [first.id, 0, 100])) as any)
        .records[0].cells[f.prop.id],
    ).toBe("Before");
    await f.host.prepareOpening("table");
    await Bun.sleep(1);
    await f.service.client.updateRecord(f.row.id, { [f.prop.id]: "After" });
    const second = (await f.host.call("openRecordQuery", [
      f.database.id,
      query,
    ])) as { id: string };
    expect(opens).toBe(3);
    expect(
      ((await f.host.call("readRecordQuery", [second.id, 0, 100])) as any)
        .records[0].cells[f.prop.id],
    ).toBe("After");
  } finally {
    f.service.dispose();
    f.db.close();
  }
});
test("partition sorting checks the database revision rather than global replica sequence", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 600; i++)
      await f.service.client.createRecord(f.database.id, {
        [f.prop.id]: String(i),
      });
    const other = await f.service.client.createDatabase({ name: "Another" });
    await f.service.client.createRecord(other.id, {});
    const query = await f.service.client.openRecordQuery(f.database.id, {
      protocol: 2,
      sort: [{ prop: f.prop.id, desc: true }],
    });
    expect(query.total).toBe(601);
    expect((await f.service.client.recordQueryStatus(query.id)).total).toBe(
      601,
    );
  } finally {
    f.service.dispose();
    f.db.close();
  }
});
test("calendar opening reuses its projected query with an unspecified end date", async () => {
  const f = fixture();
  try {
    const date = f.service.commands.addProperty(f.database.id, {
      name: "Date",
      type: "date",
    });
    await f.service.client.updateRecord(f.row.id, { [date.id]: "2026-11-11" });
    let opens = 0;
    const open = f.service.client.openRecordQuery;
    f.service.client.openRecordQuery = (...args) => {
      opens++;
      return open(...args);
    };
    const metadata = await f.host.prepareOpening("calendar");
    const { databaseViewQuery } =
      await import("../../../../../src/shared/views/database-view-query");
    const { defaultViews } =
      await import("../../../../../src/shared/views/model");
    const query = JSON.parse(
      JSON.stringify({
        ...databaseViewQuery(
          defaultViews().find((v) => v.layout === "calendar")!,
          metadata.props,
        ),
        protocol: 2,
      }),
    );
    const index = (await f.host.call("openRecordQuery", [
      f.database.id,
      query,
    ])) as any;
    expect(opens).toBe(1);
    expect(index.range.min).toBe("2026-11-11");
  } finally {
    f.service.dispose();
    f.db.close();
  }
});
test("leaving during metadata preparation cannot start an orphan background query", async () => {
  const f = fixture();
  try {
    const props = f.service.commands.listProperties(f.database.id);
    let resolve!: (value: typeof props) => void,
      opens = 0;
    f.service.client.listProperties = () =>
      new Promise((r) => {
        resolve = r;
      });
    const open = f.service.client.openRecordQuery;
    f.service.client.openRecordQuery = (...args) => {
      opens++;
      return open(...args);
    };
    const preparation = f.host.prepareOpening("table");
    const result = preparation.then(
      () => false,
      (e) => e.message.includes("cancelled"),
    );
    await f.host.releaseQueries();
    resolve(props);
    expect(await result).toBe(true);
    expect(opens).toBe(0);
  } finally {
    f.service.dispose();
    f.db.close();
  }
});
test("a reused host accepts the new session draft revision sequence", async () => {
  const f = fixture();
  try {
    await f.host.call("checkpoint", [f.row.id, f.prop.id, "first session", 5]);
    await f.host.flush();
    await f.host.releaseQueries();
    await f.host.call("checkpoint", [f.row.id, f.prop.id, "second session", 1]);
    await f.host.flush();
    expect(f.service.commands.getRecord(f.row.id).cells[f.prop.id]).toBe(
      "second session",
    );
  } finally {
    f.service.dispose();
    f.db.close();
  }
});
test("an old checkpoint waiting for a record cannot write after session release", async () => {
  const f = fixture();
  try {
    let resolve!: (value: typeof f.row) => void;
    f.service.client.getRecord = () =>
      new Promise((r) => {
        resolve = r;
      });
    const writing = f.host
      .call("checkpoint", [f.row.id, f.prop.id, "stale", 1])
      .then(
        () => false,
        (e) => e.message.includes("cancelled"),
      );
    await f.host.releaseQueries();
    resolve(f.row);
    expect(await writing).toBe(true);
    expect(f.service.drafts.readFields(f.row.id)).toEqual({});
  } finally {
    f.service.dispose();
    f.db.close();
  }
});
