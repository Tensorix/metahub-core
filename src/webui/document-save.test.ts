import { expect, test } from "bun:test";
import { DocumentSaveQueue } from "./document-save";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function fixture() {
  let text = "initial";
  const requests: { body: string; version: string | null; pending: ReturnType<typeof deferred<{ version: string }>> }[] = [];
  const queue = new DocumentSaveQueue({
    snapshot: () => ({ title: "Document", body: text }),
    write: ({ body }, version) => {
      const pending = deferred<{ version: string }>();
      requests.push({ body, version, pending });
      return pending.promise;
    },
    isConflict: (error) => error instanceof Error && error.message === "stale",
    changed: () => {},
  });
  queue.reset("v1");
  return { queue, requests, edit(value: string) { text = value; queue.edit(); } };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("keystrokes during a save stay dirty; close flush saves the latest revision", async () => {
  const f = fixture();
  f.edit("first");
  const first = f.queue.save();
  await tick();
  f.edit("second");
  const closing = f.queue.flush();
  f.requests[0]!.pending.resolve({ version: "v2" });
  await first;
  expect(f.queue.dirty).toBe(true);
  await tick();
  expect(f.requests[1]!.body).toBe("second");
  expect(f.requests[1]!.version).toBe("v2");
  f.requests[1]!.pending.resolve({ version: "v3" });
  expect(await closing).toEqual({ ok: true });
  expect(f.queue.dirty).toBe(false);
});

test("simultaneous flushes serialize writes rather than competing with each other", async () => {
  const f = fixture(); f.edit("changed");
  const saves = [f.queue.flush(), f.queue.flush(), f.queue.save()];
  await tick();
  expect(f.requests).toHaveLength(1);
  f.requests[0]!.pending.resolve({ version: "v2" });
  expect((await Promise.all(saves)).every((result) => result.ok)).toBe(true);
  expect(f.requests).toHaveLength(1);
});

test("stale saves retain local text, block automatic retries, and fail close flush", async () => {
  const f = fixture(); f.edit("my draft");
  const save = f.queue.save(); await tick();
  f.requests[0]!.pending.reject(new Error("stale"));
  expect((await save).ok).toBe(false);
  expect(f.queue.state).toBe("conflict");
  expect(f.queue.dirty).toBe(true);
  f.edit("my newer draft");
  expect((await f.queue.flush()).ok).toBe(false);
  expect(f.requests).toHaveLength(1);
  const forced = f.queue.save(true); await tick();
  expect(f.requests[1]!.body).toBe("my newer draft");
  f.requests[1]!.pending.resolve({ version: "v3" });
  expect((await forced).ok).toBe(true);
});

test("network failure is explicit, does not clear dirty, and can be retried", async () => {
  const f = fixture(); f.edit("offline draft");
  const save = f.queue.flush(); await tick();
  f.requests[0]!.pending.reject(new Error("network down"));
  expect(await save).toEqual({ ok: false, error: "network down" });
  expect(f.queue.dirty).toBe(true);
  const retry = f.queue.flush(); await tick();
  f.requests[1]!.pending.resolve({ version: "v2" });
  expect(await retry).toEqual({ ok: true });
});

test("remote reads cannot overwrite edits or a newer save that overtook the read", async () => {
  const f = fixture();
  const revision = f.queue.revision, version = f.queue.version;
  expect(f.queue.canRefresh(revision, version)).toBe(true);
  f.edit("new text");
  expect(f.queue.canRefresh(revision, version)).toBe(false);
  const save = f.queue.save(); await tick();
  f.requests[0]!.pending.resolve({ version: "v2" }); await save;
  expect(f.queue.canRefresh(revision, version)).toBe(false);
});

test("reset invalidates older save results and queued writes", async () => {
  const f = fixture(); f.edit("old draft");
  const old = f.queue.save(); await tick();
  const queued = f.queue.save();
  f.queue.reset("remote-v9");
  f.requests[0]!.pending.resolve({ version: "old-v2" });
  await Promise.all([old, queued]);
  expect(f.queue.version).toBe("remote-v9");
  expect(f.requests).toHaveLength(1);
  expect(f.queue.dirty).toBe(false);
});

test("clean flush does not rewrite a remotely deleted document", async () => {
  const f = fixture();
  expect(await f.queue.flush()).toEqual({ ok: true });
  expect(f.requests).toHaveLength(0);
});
