import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertExistingFixtureDirectory, createGuardedClient, type Manifest } from "./acceptance-fixture.ts";
import type { S3Config, StorageClient } from "../../../src/core/sync/storage.ts";
import { sha256Hex } from "../../../src/core/cache.ts";

const ownedId = "12345678-1234-4123-8123-123456789abc";
const config: S3Config = { endpoint: "https://synthetic.invalid", bucket: "synthetic", region: "auto", accessKeyId: "synthetic-id", secretAccessKey: "synthetic-secret", prefix: `parent/_mobile-ui-acceptance/${ownedId}`, encrypt: true };
function fixture(): Manifest { return { kind: "metahub-native-acceptance", version: 1, id: ownedId, prefix: config.prefix, parentPrefix: "parent", configHash: sha256Hex(new TextEncoder().encode(JSON.stringify(config))), createdAt: "2026-10-28", status: "ready" }; }
function spy() {
  const calls: string[] = [];
  const raw: StorageClient = { async list() { calls.push("list"); return []; }, async get() { calls.push("get"); return null; }, async put() { calls.push("put"); }, async del() { calls.push("del"); } };
  return { raw, calls, record: async () => { calls.push("ledger"); } };
}
test("owned writes durably record intent before transport; deletion is always blocked", async () => {
  const s = spy(), client = createGuardedClient({ ...config }, fixture(), s.raw, s.record);
  await client.put(config.prefix + "/spaces/default/oplog/node/HEAD", new Uint8Array([1]));
  expect(s.calls).toEqual(["ledger", "put"]);
  await expect(client.del(config.prefix + "/spaces/default/oplog/node/HEAD")).rejects.toThrow("never deletes");
  expect(s.calls).toEqual(["ledger", "put"]);
});
test("neighbor prefixes, parent envelope and traversal reject before ledger or raw transport", async () => {
  const s = spy(), client = createGuardedClient({ ...config }, fixture(), s.raw, s.record);
  for (const key of [config.prefix + "-neighbor/keys/main.json", "parent/spaces/default/keys/main.json", config.prefix + "/../other", config.prefix + "/./HEAD", config.prefix + "/x\\other", config.prefix + "/x\u0000other"]) {
    await expect(client.put(key, new Uint8Array([1]))).rejects.toThrow();
    await expect(client.get(key)).rejects.toThrow();
    await expect(client.list(key)).rejects.toThrow();
  }
  await expect(client.list(config.prefix + "/", "parent/outside-cursor")).rejects.toThrow();
  expect(s.calls).toEqual([]);
});
test("missing ownership, wrong UUID, altered config and post-creation mutation never reach raw put", async () => {
  const s = spy();
  for (const marker of [{ ...fixture(), kind: "unowned" }, { ...fixture(), id: "not-a-uuid" }, { ...fixture(), prefix: "parent" }, { ...fixture(), configHash: "" }]) {
    expect(() => createGuardedClient({ ...config }, marker as Manifest, s.raw, s.record)).toThrow();
  }
  for (const altered of [{ ...config, endpoint: "https://other.invalid" }, { ...config, bucket: "neighbor" }, { ...config, prefix: config.prefix + "-neighbor" }]) {
    expect(() => createGuardedClient(altered, fixture(), s.raw, s.record)).toThrow();
  }
  const mutable = { ...config }, client = createGuardedClient(mutable, fixture(), s.raw, s.record);
  mutable.bucket = "other";
  await expect(client.put(config.prefix + "/spaces/default/HEAD", new Uint8Array())).rejects.toThrow("fingerprint");
  expect(s.calls).toEqual([]);
});
test("failed ownership-ledger persistence prevents a remote write", async () => {
  const s = spy(), client = createGuardedClient({ ...config }, fixture(), s.raw, async () => { throw new Error("disk full"); });
  await expect(client.put(config.prefix + "/spaces/default/HEAD", new Uint8Array())).rejects.toThrow("disk full");
  expect(s.calls).toEqual([]);
});
const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });
test("private directory validation rejects symlink roots, symlink children and outside neighbors", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "mh-fixture-guard-")); temporary.push(dir);
  const allowed = join(dir, "private"), child = join(allowed, "child"), outside = join(dir, "outside");
  await mkdir(child, { recursive: true }); await mkdir(outside);
  await assertExistingFixtureDirectory(child, allowed);
  await symlink(outside, join(allowed, "linked"));
  await expect(assertExistingFixtureDirectory(join(allowed, "linked"), allowed)).rejects.toThrow("symlinks");
  await symlink(allowed, join(dir, "alias"));
  await expect(assertExistingFixtureDirectory(join(dir, "alias/child"), join(dir, "alias"))).rejects.toThrow("symlinks");
  await expect(assertExistingFixtureDirectory(outside, allowed)).rejects.toThrow("beneath");
});
