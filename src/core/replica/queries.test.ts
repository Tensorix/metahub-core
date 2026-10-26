import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { createReplicaService } from "./service.ts";
import { replicaRpcOps } from "./rpc.ts";

function fixture() {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key,value) VALUES ('node_id','queries')").run();
  const service = createReplicaService(db, { searchBatchSize: 7 });
  return { db, service };
}

test("reference summaries resolve only requested live ids in order, with explicit missing and empty labels", async () => {
  const { db, service } = fixture();
  try {
    const d = service.commands.createDatabase({ name: "References" });
    const title = service.commands.addProperty(d.id, { name: "Name", type: "text" });
    service.commands.addProperty(d.id, { name: "Other", type: "text" });
    const named = service.commands.createRecord(d.id, { Name: "Readable", Other: "Not the title" });
    const empty = service.commands.createRecord(d.id, {});
    const deleted = service.commands.createRecord(d.id, { Name: "Deleted" });
    service.commands.deleteRecord(deleted.id);
    const ids = [named.id, "rec_missing", empty.id, deleted.id, named.id];
    expect(await service.client.referenceSummaries({ kind: "record", databaseId: d.id, ids })).toEqual([
      { id: named.id, title: "Readable", missing: false },
      { id: "rec_missing", title: null, missing: true },
      { id: empty.id, title: null, missing: false },
      { id: deleted.id, title: null, missing: true },
      { id: named.id, title: "Readable", missing: false },
    ]);
    service.commands.updateProperty(title.id, { name: "Renamed" });
    service.commands.updateRecord(named.id, { Renamed: "New title" });
    expect(service.commands.referenceSummaries({ kind: "record", ids: [named.id] })[0]?.title).toBe("New title");
    const doc = service.commands.createDocument({ title: "Document label", body: "Body should stay out of summary" });
    expect(service.commands.referenceSummaries({ kind: "document", ids: [doc.id] })).toEqual([{ id: doc.id, title: "Document label", missing: false }]);
    expect(service.commands.referenceSummaries({ kind: "document", databaseId: d.id, ids: [doc.id] })[0]?.missing).toBe(true);
    expect(service.commands.referenceSummaries({ kind: "document", ids: [] })).toEqual([]);
    const many = Array.from({ length: 451 }, (_, i) => `doc_missing_${i}`);
    expect(service.commands.referenceSummaries({ kind: "document", ids: many })).toHaveLength(451);
  } finally { service.dispose(); db.close(); }
});

test("new replica query and reorder commands are available through browser RPC, with change notifications", async () => {
  const { db, service } = fixture();
  try {
    const rpc = replicaRpcOps(() => service);
    const d = service.commands.createDatabase({ name: "Order" });
    const p = service.commands.addProperty(d.id, { name: "Choice", type: "select", config: { options: ["a", "b"] } });
    const q = service.commands.addProperty(d.id, { name: "Text", type: "text" });
    let notifications = 0;
    const off = service.onChange(() => { notifications++; });
    rpc.moveProperty!(q.id, p.id, "before");
    rpc.moveSelectOption!(p.id, "b", "a", "before");
    expect(notifications).toBe(2);
    off();
    expect(service.commands.listProperties(d.id).map(p => p.id)).toEqual([q.id, p.id]);
    for (let i = 0; i < 65; i++) service.commands.createDocument({ title: "Shared", body: "oldquery" });
    const latest = service.commands.createDocument({ title: "Latest", body: "newquery" });
    const [old, none, next] = await Promise.all([
      service.client.querySearch("oldquery", { offset: 50, limit: 50 }),
      service.client.querySearch("nomatches"),
      service.client.querySearch("newquery"),
    ]);
    expect(old.hits).toHaveLength(15);
    expect(none.hits).toEqual([]);
    expect(next.hits.map(hit => hit.id)).toEqual([latest.id]);
    expect((rpc.querySearch!("newquery") as any).hits.map((hit: any) => hit.id)).toEqual([latest.id]);
    expect(rpc.referenceSummaries!({ kind: "document", ids: [latest.id] })).toEqual([{ id: latest.id, title: "Latest", missing: false }]);
  } finally { service.dispose(); db.close(); }
});

test("document drafts survive failed deletes and are removed only through explicit discard", async () => {
  const { db, service } = fixture();
  try {
    const doc = service.commands.createDocument({ title: "Keep recovery", body: "Saved" });
    service.drafts.checkpointDocument(doc.id, { revision: 1, title: "Draft", body: "Unsaved", version: doc.version });
    db.exec("CREATE TRIGGER failed_delete BEFORE INSERT ON crdt_changes WHEN NEW.col = '__deleted' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await expect(service.client.deleteDocument(doc.id)).rejects.toThrow("disk full");
    expect(service.drafts.readDocument(doc.id)?.body).toBe("Unsaved");
    db.exec("DROP TRIGGER failed_delete");
    expect(await service.client.deleteDocument(doc.id)).toEqual({ ok: true });
    expect(service.drafts.readDocument(doc.id)?.body).toBe("Unsaved");
    service.drafts.discardDocument(doc.id);
    expect(service.drafts.readDocument(doc.id)).toBeNull();
  } finally { service.dispose(); db.close(); }
});


test("disposing native querySearch prevents a delayed continuation from accessing closed SQLite", async () => {
  const { db, service } = fixture();
  for (let i = 0; i < 10; i++) service.commands.createDocument({ title: "Cancel", body: "pendingquery" });
  const pending = service.client.querySearch("pendingquery");
  service.dispose();
  db.close();
  await expect(pending).rejects.toThrow();
});
