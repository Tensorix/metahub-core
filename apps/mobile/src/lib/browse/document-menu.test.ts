import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../../../../../src/core/db";
import { createReplicaService } from "../../../../../src/core/replica/service";
import { createRecentStore } from "../navigation/recent";
import { deleteListedDocument } from "../document-actions";
import { documentMenuItems, readDocumentMenu } from "./document-menu";

function fixture() {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta(key,value) VALUES ('node_id','menu-test')").run();
  const service = createReplicaService(db);
  const parent = service.commands.createDocument({
    title: "Parent",
    body: "Saved",
  });
  const child = service.commands.createDocument({
    title: "Child",
    parent_id: parent.id,
  });
  const recent = createRecentStore(db, "workspace-a");
  const other = createRecentStore(db, "workspace-b");
  for (const store of [recent, other])
    store.remember({ kind: "document", id: parent.id, title: parent.title });
  service.drafts.checkpointDocument(parent.id, {
    revision: 1,
    title: "Draft",
    body: "Recovery",
    version: parent.version,
  });
  const remove = (isCurrent = () => true) =>
    deleteListedDocument({
      protect: async () => () => {
        released++;
      },
      isCurrent,
      commit: () => service.client.deleteDocument(parent.id),
      discardDraft: () => service.drafts.discardDocument(parent.id),
      forgetRecent: () => recent.forget("document", parent.id),
    });
  let released = 0;
  return {
    db,
    service,
    parent,
    child,
    recent,
    other,
    remove,
    released: () => released,
    close() {
      service.dispose();
      db.close();
    },
  };
}

test("menu matches WebUI order and reads current parent/title after moves", async () => {
  const f = fixture();
  try {
    expect(
      documentMenuItems(!!readDocumentMenu(f.db, f.child.id)?.parent_id).map(
        (i) => i.title,
      ),
    ).toEqual(["新建子页", "复制 ID", "重命名…", "移到顶层", "删除"]);
    const openedAt = f.recent.read()[0]!.openedAt;
    await f.service.client.updateDocument(f.child.id, {
      parent_id: null,
      title: "Renamed",
    });
    const doc = readDocumentMenu(f.db, f.child.id)!;
    expect(doc.title).toBe("Renamed");
    expect(documentMenuItems(!!doc.parent_id).map((i) => i.id)).toEqual([
      "child",
      "copy-id",
      "rename",
      "delete",
    ]);
    expect(f.recent.read()[0]!.openedAt).toBe(openedAt);
    await f.service.client.deleteDocument(f.child.id);
    expect(readDocumentMenu(f.db, f.child.id)).toBeNull();
  } finally {
    f.close();
  }
});

test("removing recent preserves the document and other workspace; reopening restores it", () => {
  const f = fixture();
  try {
    f.recent.forget("document", f.parent.id);
    expect(f.recent.read()).toEqual([]);
    expect(readDocumentMenu(f.db, f.parent.id)).not.toBeNull();
    expect(f.other.read()).toHaveLength(1);
    f.recent.remember({
      kind: "document",
      id: f.parent.id,
      title: f.parent.title,
    });
    expect(f.recent.read()).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("list deletion preserves recovery on failure and promotes children on success", async () => {
  const f = fixture();
  try {
    f.db.exec(
      "CREATE TRIGGER fail_delete BEFORE INSERT ON crdt_changes WHEN NEW.col='__deleted' BEGIN SELECT RAISE(ABORT,'disk full'); END",
    );
    await expect(f.remove()).rejects.toThrow("disk full");
    expect(f.service.drafts.readDocument(f.parent.id)?.body).toBe("Recovery");
    expect(f.recent.read()).toHaveLength(1);
    expect(readDocumentMenu(f.db, f.child.id)?.parent_id).toBe(f.parent.id);
    expect(f.released()).toBe(1);
    f.db.exec("DROP TRIGGER fail_delete");
    await f.remove();
    expect(readDocumentMenu(f.db, f.parent.id)).toBeNull();
    expect(readDocumentMenu(f.db, f.child.id)?.parent_id).toBeNull();
    expect(f.service.drafts.readDocument(f.parent.id)).toBeNull();
    expect(f.recent.read()).toEqual([]);
    expect(f.other.read()).toHaveLength(1);
    expect(f.released()).toBe(2);
  } finally {
    f.close();
  }
});

test("workspace switch while protecting editors aborts list deletion", async () => {
  const f = fixture();
  try {
    await expect(f.remove(() => false)).rejects.toThrow("工作区会话已结束");
    expect(readDocumentMenu(f.db, f.parent.id)).not.toBeNull();
    expect(f.service.drafts.readDocument(f.parent.id)).not.toBeNull();
    expect(f.recent.read()).toHaveLength(1);
    expect(f.released()).toBe(1);
  } finally {
    f.close();
  }
});
