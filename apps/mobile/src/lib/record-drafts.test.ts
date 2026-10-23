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
