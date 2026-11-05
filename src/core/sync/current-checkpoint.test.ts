import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { createDocument, updateDocument, getDocument, documentVersion } from "../documents.ts";
import { documentAtVersion } from "../history.ts";
import { captureDocumentArchive, installDocumentArchive } from "../history-archive.ts";
import { captureCurrentCheckpoint, installCurrentCheckpoint } from "./current-checkpoint.ts";
function database() { const d = new Database(":memory:"); runSchema(d); return d; }
test("slim current baseline hydrates live content while independent history recovers deleted text", () => {
  const a = database(), b = database();
  try {
    const doc = createDocument(a, { title: "T", body: "previous secret text" });
    const version = documentVersion(a, doc.id);
    updateDocument(a, doc.id, { body: "current text" });
    const archive = captureDocumentArchive(a, "workspace", doc.id);
    const checkpoint = captureCurrentCheckpoint(a, "workspace", 0);
    expect(checkpoint.deletedBlocks.length).toBe(1);
    expect(checkpoint.changes.some(c => c.col === "text" && c.value?.includes("previous secret text"))).toBe(false);
    installCurrentCheckpoint(b, checkpoint, "workspace");
    expect(getDocument(b, doc.id)!.body).toBe("current text");
    installDocumentArchive(b, archive, "workspace");
    expect(documentAtVersion(b, doc.id, version).body).toBe("previous secret text");
    expect(getDocument(b, doc.id)!.body).toBe("current text");
    expect(() => installCurrentCheckpoint(b, checkpoint, "workspace")).toThrow("empty shadow");
  } finally { a.close(); b.close(); }
});
test("malformed checkpoint fails before any shadow writes", () => {
  const a = database(), b = database();
  try {
    createDocument(a, { title: "T", body: "content" });
    const checkpoint = captureCurrentCheckpoint(a, "workspace", 0);
    checkpoint.changes.push(checkpoint.changes[0]!);
    expect(() => installCurrentCheckpoint(b, checkpoint, "workspace")).toThrow("multiple register");
    expect(b.query("SELECT COUNT(*) AS n FROM crdt_changes").get()).toEqual({ n: 0 });
  } finally { a.close(); b.close(); }
});
