import { expect, test } from "bun:test";
import { createUndoStore, undoStoreFor } from "./undo-store";

test("queued actions keep their own undo and duplicate presses cannot execute twice", async () => {
  const store = createUndoStore();
  let complete!: () => void;
  let calls = 0;
  store.push("First", async () => { calls++; await new Promise<void>(resolve => { complete = resolve; }); });
  const first = store.snapshot().entries[0]!.id;
  const pending = store.undo(first);
  store.push("Second", async () => {});
  await store.undo(first);
  store.dismiss(first);
  expect(calls).toBe(1);
  expect(store.snapshot().entries).toHaveLength(2);
  complete();
  await pending;
  expect(store.snapshot().entries).toHaveLength(1);
  expect(store.snapshot().entries[0]?.message).toBe("Second");
});

test("failed undo remains retryable and session queues stay separate", async () => {
  const a = {}, b = {};
  const store = undoStoreFor(a);
  expect(undoStoreFor(a)).toBe(store);
  expect(undoStoreFor(b)).not.toBe(store);
  let failure = true;
  store.push("Deleted", async () => { if (failure) throw Error("offline"); });
  const id = store.snapshot().entries[0]!.id;
  await store.undo(id);
  expect(store.snapshot().error).toBe("offline");
  expect(store.snapshot().entries[0]?.id).toBe(id);
  failure = false;
  await store.undo(id);
  expect(store.snapshot().error).toBeNull();
  expect(store.snapshot().entries).toEqual([]);
  expect(undoStoreFor(b).snapshot().entries).toEqual([]);
});

test("successful restore removes the notice without creating a success popup", async () => {
  const store = createUndoStore();
  store.push("已移出最近", async () => "已恢复最近记录");
  await store.undo(store.snapshot().entries[0]!.id);
  expect(store.snapshot()).toEqual({ entries: [], busy: false, error: null });
});
