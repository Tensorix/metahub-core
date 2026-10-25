import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore } from "../../../../../src/core/replica/drafts";
import { EditorHost, type EditorHostServices } from "./host";
import { parseEditorMessage, scriptJSON, type EditorDraft, type EditorRequest } from "./protocol";

const draft = (revision: number, body = `text ${revision}`, version: string | null = "v1"): EditorDraft => ({ revision, title: "Title", body, version });
const request = (id: number, method: EditorRequest["method"], params: unknown = null): EditorRequest => ({ v: 1, session: "renderer", type: "request", id, method, params });
const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "metahub-editor-")); paths.push(path);
  const file = join(path, "replica.db");
  let db = new Database(file);
  let store = createDraftStore(db);
  let active = true;
  const calls: string[] = [];
  const services: EditorHostServices = {
    async load() { return { title: "Title", body: "remote", version: "v1" }; },
    async readDraft() { return store.readDocument("doc"); },
    async checkpoint(value) { calls.push(`checkpoint:${value.revision}`); store.checkpointDocument("doc", value); },
    async acknowledge(revision) { calls.push(`ack:${revision}`); store.acknowledgeDocument("doc", revision); },
    async save() { calls.push("save"); return { version: "v2" }; },
    isCurrent: () => active,
  };
  return { services, calls, get store() { return store; }, stop() { active = false; }, reopen() { db.close(); db = new Database(file); store = createDraftStore(db); }, close() { db.close(); } };
}
describe("native editor durable bridge", () => {
  test("checkpoint survives process restart, and load recovers it before local document", async () => {
    const f = fixture();
    const original = new EditorHost("renderer", f.services);
    expect((await original.request(request(1, "checkpoint", draft(4))))?.ok).toBe(true);
    original.dispose(); f.reopen();
    const recovered = await new EditorHost("renderer", f.services).request(request(1, "load"));
    expect(recovered?.value).toEqual({ ...draft(4), recovered: true }); f.close();
  });
  test("failed local save retains checkpoint and retry acknowledges only successful revision", async () => {
    const f = fixture();
    f.services.save = async () => { throw new Error("disk full"); };
    const host = new EditorHost("renderer", f.services);
    expect((await host.request(request(1, "save", { ...draft(1), force: false })))?.ok).toBe(false);
    expect(f.store.readDocument("doc")).toEqual(draft(1));
    f.services.save = async () => ({ version: "v2" });
    expect((await host.request(request(2, "save", { ...draft(1), force: false })))?.ok).toBe(true);
    expect(f.store.readDocument("doc")).toBeNull(); f.close();
  });
  test("save preserves newer checkpoint and rebases its version for recovery", async () => {
    const f = fixture(); const host = new EditorHost("renderer", f.services);
    await host.request(request(1, "checkpoint", draft(2, "newer text")));
    await host.request(request(2, "save", { ...draft(1, "older save"), force: false }));
    expect(f.store.readDocument("doc")).toEqual(draft(2, "newer text", "v2"));
    // A checkpoint created by JS before its save response arrived is rebased too.
    await host.request(request(3, "checkpoint", draft(3, "latest text")));
    expect(f.store.readDocument("doc")).toEqual(draft(3, "latest text", "v2")); f.close();
  });
  test("a slow native picker does not delay a durable text checkpoint", async () => {
    const f = fixture(); let finish!: (value: Record<string, never>) => void;
    f.services.media = () => new Promise(resolve => { finish = resolve; });
    const host = new EditorHost("renderer", f.services);
    const picker = host.request(request(1, "media", { action: "pick" }));
    await host.request(request(2, "checkpoint", draft(1)));
    expect(f.store.readDocument("doc")).toEqual(draft(1));
    finish({}); await picker; f.close();
  });
  test("switched session does not acknowledge or reply after an old save resolves", async () => {
    const f = fixture(); let finish!: (value: { version: string }) => void;
    f.services.save = () => new Promise(resolve => { finish = resolve; });
    const host = new EditorHost("renderer", f.services);
    const pending = host.request(request(1, "save", { ...draft(1), force: false }));
    await new Promise(resolve => setTimeout(resolve, 0));
    f.stop(); finish({ version: "v2" });
    expect(await pending).toBeNull();
    expect(f.calls).toEqual(["checkpoint:1"]); expect(f.store.readDocument("doc")).toEqual(draft(1)); f.close();
  });
  test("duplicate and old renderer requests cannot mutate a replacement session", async () => {
    const f = fixture(); const host = new EditorHost("renderer", f.services);
    await host.request(request(1, "checkpoint", draft(2)));
    expect(await host.request(request(1, "checkpoint", draft(3)))).toBeNull();
    expect(await host.request({ ...request(2, "checkpoint", draft(4)), session: "old" })).toBeNull();
    expect((await host.request(request(3, "checkpoint", draft(1))))?.ok).toBe(false);
    expect(f.store.readDocument("doc")).toEqual(draft(2)); f.close();
  });
});
test("protocol rejects malformed messages, script injection, and credential capabilities", () => {
  const parse = (value: unknown) => parseEditorMessage(JSON.stringify(value), "renderer");
  expect(parse(request(1, "checkpoint", draft(1)))).not.toBeNull();
  expect(parse(request(1, "save", { ...draft(1), force: "yes" }))).toBeNull();
  expect(parse(request(1, "checkpoint", { ...draft(1), revision: -1 }))).toBeNull();
  expect(parse({ ...request(1, "load"), session: "old" })).toBeNull();
  expect(parse({ ...request(1, "load"), method: "fetch", params: "/auth/token" })).toBeNull();
  expect(scriptJSON("</script>\u2028")).not.toContain("<");
  expect(JSON.parse(scriptJSON("</script>\u2028"))).toBe("</script>\u2028");
});
