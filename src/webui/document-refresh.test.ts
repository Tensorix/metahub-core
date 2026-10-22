import { expect, test } from "bun:test";
import { createDocumentRefresh } from "./document-refresh";
import { DocumentSaveQueue } from "./document-save";

test("a read overtaken by a save still drains the pending remote notification", async () => {
  let finishRead!: () => void;
  let reads = 0;
  let shown = "v1";
  const saver = new DocumentSaveQueue({
    snapshot: () => ({ title: "", body: "edit" }),
    write: async () => ({ version: "v3" }), isConflict: () => false, changed: () => {},
  });
  saver.reset("v1");
  const refresh = createDocumentRefresh(async () => {
    const revision = saver.revision, version = saver.version;
    const read = ++reads;
    if (read === 1) await new Promise<void>((resolve) => { finishRead = resolve; });
    if (!saver.canRefresh(revision, version)) return;
    shown = read === 1 ? "v2" : "v4";
    saver.reset(shown);
  }, (error) => { throw error; });
  const first = refresh.request();
  saver.edit(); await saver.flush(); // The first read is now obsolete.
  await refresh.request(); // v4 arrives while the v2 read is still pending.
  finishRead(); await first;
  expect(reads).toBe(2);
  expect(shown).toBe("v4");
});

test("disposed refresh queue never starts a trailing read", async () => {
  let finish!: () => void;
  let reads = 0;
  const refresh = createDocumentRefresh(async () => {
    reads++; await new Promise<void>((resolve) => { finish = resolve; });
  }, () => {});
  const run = refresh.request();
  await refresh.request(); refresh.dispose(); finish(); await run;
  expect(reads).toBe(1);
});
