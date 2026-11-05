import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import { createDocument, updateDocument, documentVersion, getDocument } from "./documents.ts";
import { documentAtVersion } from "./history.ts";
import { splitDocumentArchive, captureDocumentArchive, installDocumentArchive, publishDocumentArchive, fetchDocumentArchive } from "./history-archive.ts";
import { generateMasterKey } from "./sync/e2ee.ts";
import type { StorageClient } from "./sync/storage.ts";
function database() { const db = new Database(":memory:"); runSchema(db); return db; }
test("encrypted document history restores on a separate replica without ingesting current state", async () => {
  const a = database(), b = database();
  try {
    const doc = createDocument(a, { title: "T", body: "original" });
    const before = documentVersion(a, doc.id);
    updateDocument(a, doc.id, { body: "edited" });
    const archive = captureDocumentArchive(a, "workspace", doc.id);
    const objects = new Map<string, Uint8Array>();
    const client: StorageClient = { list: async () => [], get: async k => objects.get(k) ?? null, put: async (k,v) => { objects.set(k,v); }, del: async k => { objects.delete(k); } };
    const key = generateMasterKey();
    const ref = await publishDocumentArchive(client, "v2", key, archive);
    expect(new TextDecoder().decode(objects.get(ref.key))).not.toContain("original");
    const fetched = await fetchDocumentArchive(client, key, ref, "workspace");
    installDocumentArchive(b, fetched, "workspace");
    expect(documentAtVersion(b, doc.id, before).body).toBe("original");
    expect(documentAtVersion(b, doc.id, documentVersion(a, doc.id)).body).toBe("edited");
    expect(getDocument(b, doc.id)).toBeNull();
    expect(b.query("SELECT COUNT(*) AS n FROM crdt_changes").get()).toEqual({ n: 0 });
    installDocumentArchive(b, fetched, "workspace");
    expect(documentAtVersion(b, doc.id, before).body).toBe("original");
    objects.delete(ref.key);
    await expect(fetchDocumentArchive(client, key, ref, "workspace")).rejects.toMatchObject({ code: "history_unavailable" });
  } finally { a.close(); b.close(); }
});
test("history installation refuses cross-workspace and unrelated entity data", () => {
  const db = database();
  try {
    const doc = createDocument(db, { title: "T", body: "text" });
    const archive = captureDocumentArchive(db, "workspace", doc.id);
    expect(() => installDocumentArchive(db, archive, "other")).toThrow("workspace");
    expect(() => installDocumentArchive(db, { ...archive, observedAt: undefined, changes: [...archive.changes, { ...archive.changes[0]!, dataset: "records" }] }, "workspace")).toThrow("unrelated");
  } finally { db.close(); }
});

test("history observation timestamps survive archive roundtrip and malformed coverage is rejected", () => {
  const a = database(), b = database();
  try {
    const doc = createDocument(a, { title: "T", body: "text" });
    const archive = captureDocumentArchive(a, "workspace", doc.id);
    const observed = { ...archive, observedAt: archive.changes.map(() => 123456) };
    installDocumentArchive(b, observed, "workspace");
    expect(captureDocumentArchive(b, "workspace", doc.id).observedAt).toEqual(observed.observedAt);
    expect(() => installDocumentArchive(b, { ...observed, observedAt: [] }, "workspace")).toThrow("observation count");
    const conflicting = { ...observed, changes: observed.changes.map((c,i) => i === 0 ? { ...c, value: '"corrupt"' } : c) };
    expect(() => installDocumentArchive(b, conflicting, "workspace")).toThrow("conflicting history");
    expect(captureDocumentArchive(b, "workspace", doc.id)).toEqual(observed);
  } finally { a.close(); b.close(); }
});


test("document history chunks validate independently and reconstruct every retained revision", () => {
  const a = database(), b = database();
  try {
    const doc = createDocument(a,{ title: "chunks",body: "original paragraph" });
    const before = documentVersion(a,doc.id);
    for (let i = 0; i < 30; i++) updateDocument(a,doc.id,{ body: `revision ${i} paragraph` });
    const archive = captureDocumentArchive(a,"workspace",doc.id);
    const parts = splitDocumentArchive(archive,2048);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) installDocumentArchive(b,part,"workspace");
    expect(documentAtVersion(b,doc.id,before).body).toBe("original paragraph");
    expect(documentAtVersion(b,doc.id,documentVersion(a,doc.id)).body).toBe("revision 29 paragraph");
    expect(captureDocumentArchive(b,"workspace",doc.id).changes.length).toBe(archive.changes.length);
    expect(getDocument(b,doc.id)).toBeNull();
  } finally { a.close(); b.close(); }
});
