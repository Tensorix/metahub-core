/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { RecordDrafts, parseNumberDraft } from "./record-drafts";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() { let resolve!: () => void; let reject!: (e: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
describe("record drafts", () => {
  test("serializes and coalesces rapid same-field arrays without losing selections", async () => {
    const first = deferred(); const calls: unknown[] = [];
    const drafts = new RecordDrafts(async (_, value) => { calls.push(value); if (calls.length === 1) await first.promise; }, () => {});
    drafts.save("relation", ["a"]); drafts.save("relation", ["a", "b"]); drafts.save("relation", ["a", "b", "c"]);
    expect(calls).toEqual([["a"]]); first.resolve(); await tick();
    expect(calls).toEqual([["a"], ["a", "b", "c"]]); expect(drafts.dirty).toBe(false);
  });
  test("a failed request retains its draft for explicit retry", async () => {
    let fail = true;
    const drafts = new RecordDrafts(async () => { if (fail) throw new Error("offline"); }, () => {});
    drafts.save("text", "keep me"); await tick();
    expect(drafts.fields.get("text")).toMatchObject({ value: "keep me", status: "error" }); expect(drafts.dirty).toBe(true);
    drafts.reconcile({ text: "server" }); expect(drafts.fields.get("text")?.value).toBe("keep me");
    fail = false; drafts.retry(); await tick(); expect(drafts.dirty).toBe(false);
  });
  test("older success cannot clear a newer unsubmitted text draft", async () => {
    const request = deferred();
    const drafts = new RecordDrafts(() => request.promise, () => {});
    drafts.save("text", "first"); drafts.stage("text", "newer draft"); request.resolve(); await tick();
    expect(drafts.fields.get("text")).toEqual({ value: "newer draft", status: "draft" }); expect(drafts.dirty).toBe(true);
  });
  test("older failure does not discard a newer queued edit", async () => {
    const request = deferred(); let count = 0;
    const drafts = new RecordDrafts(() => ++count === 1 ? request.promise : Promise.resolve(), () => {});
    drafts.save("text", "first"); drafts.save("text", "second"); request.reject(new Error("offline")); await tick();
    expect(drafts.fields.get("text")).toMatchObject({ value: "second", status: "saved" });
  });
  test("invalid numbers remain local and retry never sends them", async () => {
    let calls = 0; const drafts = new RecordDrafts(async () => { calls++; }, () => {});
    drafts.stage("number", "bad"); drafts.fail("number", "请输入有效数字"); drafts.retry(); await tick();
    expect(calls).toBe(0); expect(drafts.dirty).toBe(true);
    expect(parseNumberDraft("  ")).toBeNull(); expect(parseNumberDraft("1.25")).toBe(1.25); expect(() => parseNumberDraft("bad")).toThrow();
  });
  test("refresh preserves dirty text but releases acknowledged values for remote/history updates", async () => {
    const drafts = new RecordDrafts(async () => {}, () => {});
    drafts.stage("text", "unsaved"); drafts.reconcile({ text: "restored history" });
    expect(drafts.fields.get("text")?.value).toBe("unsaved");
    drafts.save("text", "unsaved"); await tick(); drafts.reconcile({ text: "unsaved" });
    expect(drafts.fields.has("text")).toBe(false);
    drafts.reconcile({ text: "restored history" }); expect(drafts.fields.has("text")).toBe(false);
  });
  test("post-write remote changes replace saved overlays, pre-write reads cannot", async () => {
    const request = deferred(); const drafts = new RecordDrafts(() => request.promise, () => {});
    const oldReadVersion = drafts.acknowledgedVersion;
    drafts.save("text", "ours"); request.resolve(); await tick();
    drafts.reconcile({ text: "old server value" }, oldReadVersion);
    expect(drafts.fields.get("text")?.value).toBe("ours");
    const freshReadVersion = drafts.acknowledgedVersion;
    drafts.reconcile({ text: "other device or restored history" }, freshReadVersion);
    expect(drafts.fields.has("text")).toBe(false);
  });
  test("unmount suppresses callbacks and StrictMode setup resumes pending edits", async () => {
    const request = deferred(); let changes = 0; let settled = 0; let count = 0;
    const drafts = new RecordDrafts(async () => { if (++count === 1) await request.promise; }, () => { changes++; }, () => { settled++; });
    drafts.save("a", "first"); drafts.save("b", "next"); drafts.stop(); const before = changes;
    request.resolve(); await tick(); expect(changes).toBe(before); expect(settled).toBe(0);
    drafts.resume(); await tick(); expect(count).toBe(2); expect(drafts.dirty).toBe(false); expect(settled).toBe(1);
  });
  test("saved overlays remain until confirmed by refresh; discard stops queued writes", async () => {
    const request = deferred(); const calls: string[] = [];
    const drafts = new RecordDrafts(async (id) => { calls.push(id); await request.promise; }, () => {});
    drafts.save("a", "saved"); drafts.save("b", "queued"); drafts.stop(); request.resolve(); await tick();
    expect(calls).toEqual(["a"]); drafts.reconcile({ a: "old" }); expect(drafts.fields.has("a")).toBe(true);
    drafts.reconcile({ a: "saved" }); expect(drafts.fields.has("a")).toBe(false);
  });
});

describe("record navigation flush", () => {
  const prepare = (id: string, value: unknown) => id === "number" ? parseNumberDraft(String(value ?? "")) : value;

  test("submits unblurred text and parses number drafts before allowing departure", async () => {
    const calls: [string, unknown][] = [];
    const drafts = new RecordDrafts(async (id, value) => { calls.push([id, value]); }, () => {});
    drafts.stage("text", "latest typing"); drafts.stage("number", "12.5");
    expect(await drafts.flush(prepare)).toEqual({ ok: true });
    expect(calls).toEqual([["text", "latest typing"], ["number", 12.5]]);
    expect(drafts.dirty).toBe(false);
  });

  test("waits for an in-flight write and the newer unblurred edit that replaces it", async () => {
    const first = deferred(), second = deferred(); const calls: unknown[] = [];
    const drafts = new RecordDrafts(async (_id, value) => { calls.push(value); await (calls.length === 1 ? first.promise : second.promise); }, () => {});
    drafts.save("text", "first");
    let done = false; const flushing = drafts.flush().then(result => { done = true; return result; });
    drafts.stage("text", "newest typing"); first.resolve(); await tick();
    expect(calls).toEqual(["first", "newest typing"]); expect(done).toBe(false);
    second.resolve(); expect(await flushing).toEqual({ ok: true });
    expect(drafts.fields.get("text")).toMatchObject({ value: "newest typing", status: "saved" });
  });

  test("invalid numeric drafts block departure and never reach the writer", async () => {
    let writes = 0;
    const drafts = new RecordDrafts(async () => { writes++; }, () => {});
    drafts.stage("number", "invalid number");
    expect(await drafts.flush(prepare)).toEqual({ ok: false, error: "请输入有效数字" });
    expect(await drafts.flush(prepare)).toEqual({ ok: false, error: "请输入有效数字" });
    expect(writes).toBe(0);
    expect(drafts.fields.get("number")).toMatchObject({ value: "invalid number", status: "invalid" });
    drafts.stage("number", "2.5");
    expect(await drafts.flush(prepare)).toEqual({ ok: true }); expect(writes).toBe(1);
  });

  test("a failed flush keeps the screen blocked until another explicit attempt succeeds", async () => {
    let writes = 0, failing = true;
    const drafts = new RecordDrafts(async () => { writes++; if (failing) throw new Error("disk unavailable"); }, () => {});
    drafts.stage("text", "keep this");
    expect(await drafts.flush()).toEqual({ ok: false, error: "disk unavailable" });
    expect(writes).toBe(1); expect(drafts.dirty).toBe(true);
    expect(drafts.fields.get("text")?.value).toBe("keep this");
    failing = false;
    expect(await drafts.flush()).toEqual({ ok: true }); expect(writes).toBe(2);
  });

  test("simultaneous close attempts share a writer and do not duplicate the accepted value", async () => {
    const write = deferred(); let writes = 0;
    const drafts = new RecordDrafts(async () => { writes++; await write.promise; }, () => {});
    drafts.stage("text", "one value");
    const first = drafts.flush(), second = drafts.flush();
    expect(writes).toBe(1); write.resolve();
    expect(await first).toEqual({ ok: true }); expect(await second).toEqual({ ok: true }); expect(writes).toBe(1);
  });

  test("stopping the editor releases close waiters without approving stale navigation", async () => {
    const write = deferred(); let writes = 0;
    const drafts = new RecordDrafts(async () => { writes++; await write.promise; }, () => {});
    drafts.save("text", "first"); drafts.stage("other", "preserved draft");
    const flushing = drafts.flush(); drafts.stop();
    expect((await flushing).ok).toBe(false);
    expect(drafts.fields.get("other")?.value).toBe("preserved draft");
    write.resolve(); await tick(); expect(writes).toBe(1);
  });

  test("checkpoint failure blocks writes and departure until persistence recovers", async () => {
    let durable = false, writes = 0;
    const drafts = new RecordDrafts(async () => { writes++; }, () => {}, () => {}, () => { if (!durable) throw new Error("disk full"); });
    drafts.stage("text", "recoverable value");
    const failed = await drafts.flush();
    expect(failed.ok).toBe(false); if (!failed.ok) expect(failed.error).toContain("disk full");
    expect(writes).toBe(0); expect(drafts.dirty).toBe(true);
    durable = true;
    expect(await drafts.flush()).toEqual({ ok: true }); expect(writes).toBe(1);
  });

  test("a newer invalid edit cannot be cleared by an older successful write", async () => {
    const write = deferred(); const calls: unknown[] = [];
    const drafts = new RecordDrafts(async (_id, value) => { calls.push(value); await write.promise; }, () => {});
    drafts.save("number", 1);
    const flushing = drafts.flush(prepare);
    drafts.stage("number", "bad latest value"); write.resolve();
    expect(await flushing).toEqual({ ok: false, error: "请输入有效数字" });
    expect(calls).toEqual([1]);
    expect(drafts.fields.get("number")).toMatchObject({ value: "bad latest value", status: "invalid" });
  });
});
