import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../../../../../src/core/db";
import { createReplicaService } from "../../../../../src/core/replica/service";
import { createRecentStore } from "../navigation/recent";
import { deleteBrowseItem } from "./undo-delete";

function fixture() {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta(key,value) VALUES('node_id','undo-browse')").run();
  const service = createReplicaService(db);
  const recents = createRecentStore(db, "workspace");
  let current = true;
  return { db, service, recents,
    endSession() { current = false; },
    remove(kind: "document" | "database", id: string) {
      return deleteBrowseItem({ service, recents, kind, id, isCurrent: () => current, protect: async () => () => {} });
    },
    close() { service.dispose(); db.close(); },
  };
}

test("document undo restores its child relationship, draft and original recent position", async () => {
  const f = fixture();
  try {
    const parent = await f.service.client.createDocument({ title: "Parent", body: "saved" });
    const child = await f.service.client.createDocument({ title: "Child", parent_id: parent.id });
    f.recents.remember({ kind: "document", id: parent.id, title: "Parent" });
    const recent = f.recents.read()[0]!;
    f.service.drafts.checkpointDocument(parent.id, { revision: 5, title: "Draft", body: "unsaved", version: parent.version });
    let changes = 0;
    f.service.onChange(() => changes++);
    const receipt = await f.remove("document", parent.id);
    expect((await f.service.client.getDocument(child.id)).parent_id).toBeNull();
    expect(f.service.drafts.readDocument(parent.id)).toBeNull();
    expect(f.recents.read()).toEqual([]);
    await receipt.undo();
    expect((await f.service.client.getDocument(parent.id)).body).toBe("saved");
    expect((await f.service.client.getDocument(child.id)).parent_id).toBe(parent.id);
    expect(f.service.drafts.readDocument(parent.id)?.body).toBe("unsaved");
    expect(f.recents.read()).toEqual([recent]);
    expect(changes).toBe(2);
  } finally { f.close(); }
});

test("database undo restores records, fields, scoped documents and recovery drafts", async () => {
  const f = fixture();
  try {
    const table = await f.service.client.createDatabase({ name: "Table" });
    const field = await f.service.client.addProperty(table.id, { name: "Name", type: "text" });
    const record = await f.service.client.createRecord(table.id, { Name: "Row" });
    const doc = await f.service.client.createDocument({ title: "Scoped", database_id: table.id });
    f.service.drafts.checkpointField(record.id, field.id, { value: "pending edit", status: "pending" });
    f.recents.remember({ kind: "database", id: table.id, title: table.name });
    f.recents.remember({ kind: "record", id: record.id, title: "Row" });
    const recent = f.recents.read();
    const receipt = await f.remove("database", table.id);
    expect(await f.service.client.listDatabases()).toEqual([]);
    expect(f.service.drafts.readFields(record.id)).toEqual({});
    await receipt.undo();
    expect((await f.service.client.listDatabases())[0]?.id).toBe(table.id);
    expect((await f.service.client.listProperties(table.id))[0]?.id).toBe(field.id);
    expect((await f.service.client.getRecord(record.id)).id).toBe(record.id);
    expect((await f.service.client.getDocument(doc.id)).database_id).toBe(table.id);
    expect(f.service.drafts.readFields(record.id)[field.id]?.value).toBe("pending edit");
    expect(f.recents.read()).toEqual(recent);
  } finally { f.close(); }
});

test("undo preserves later moves, newer visits and new drafts", async () => {
  const f = fixture();
  try {
    const parent = await f.service.client.createDocument({ title: "Parent" });
    const child = await f.service.client.createDocument({ title: "Child", parent_id: parent.id });
    const other = await f.service.client.createDocument({ title: "Other" });
    f.service.drafts.checkpointDocument(parent.id, { revision: 1, title: "Old", body: "old", version: parent.version });
    f.recents.remember({ kind: "document", id: parent.id, title: "Parent" });
    const receipt = await f.remove("document", parent.id);
    await f.service.client.updateDocument(child.id, { parent_id: other.id });
    f.service.drafts.checkpointDocument(parent.id, { revision: 9, title: "New", body: "new", version: parent.version });
    f.recents.remember({ kind: "document", id: parent.id, title: "Newer visit" });
    const message = await receipt.undo();
    expect(message).toContain("后续修改");
    expect((await f.service.client.getDocument(child.id)).parent_id).toBe(other.id);
    expect(f.service.drafts.readDocument(parent.id)?.body).toBe("new");
    expect(f.recents.read()[0]?.title).toBe("Newer visit");
  } finally { f.close(); }
});

test("failed deletion keeps content and drafts; expired sessions cannot undo", async () => {
  const f = fixture();
  try {
    const doc = await f.service.client.createDocument({ title: "Keep" });
    f.service.drafts.checkpointDocument(doc.id, { revision: 1, title: "Draft", body: "draft", version: doc.version });
    f.db.exec("CREATE TRIGGER fail_delete BEFORE INSERT ON crdt_changes WHEN NEW.col='__deleted' BEGIN SELECT RAISE(ABORT,'disk full'); END");
    await expect(f.remove("document", doc.id)).rejects.toThrow("disk full");
    expect((await f.service.client.getDocument(doc.id)).title).toBe("Keep");
    expect(f.service.drafts.readDocument(doc.id)).not.toBeNull();
    f.db.exec("DROP TRIGGER fail_delete");
    const receipt = await f.remove("document", doc.id);
    f.endSession();
    await expect(receipt.undo()).rejects.toThrow("工作区会话已结束");
  } finally { f.close(); }
});
