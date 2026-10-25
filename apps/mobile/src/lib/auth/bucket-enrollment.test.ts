import { expect, test } from "bun:test";
import {
  encryptBytes,
  toB64,
  wrapMasterKey,
} from "../../../../../src/core/sync/e2ee.ts";
import { encodeRecoveryCode } from "../../../../../src/core/sync/recovery.ts";
import type {
  S3Config,
  StorageClient,
} from "../../../../../src/core/sync/storage.ts";
import { resolveBucketEnrollment } from "./bucket-enrollment";

const config: S3Config = {
  endpoint: "https://example.test",
  bucket: "test-bucket",
  region: "auto",
  prefix: "metahub",
  accessKeyId: "test-access",
  secretAccessKey: "test-secret",
  encrypt: true,
  publish: false,
};
const key = new Uint8Array(32).fill(7);
const envelopePath = "metahub/spaces/default/keys/main.json";
const ciphertextPath = "metahub/spaces/default/snapshot/fixture.vc";

function bucket(objects = new Map<string, Uint8Array>()) {
  const calls: string[] = [];
  const client: StorageClient = {
    async list(prefix) {
      calls.push(`list:${prefix}`);
      return [...objects.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => ({ key: path }));
    },
    async get(path) {
      calls.push(`get:${path}`);
      return objects.get(path) ?? null;
    },
    async put(path, data) {
      calls.push(`put:${path}`);
      objects.set(path, data);
    },
    async del(path) {
      calls.push(`del:${path}`);
      objects.delete(path);
    },
  };
  return { client, calls, objects };
}

async function encryptedBucket() {
  return bucket(new Map([
    [envelopePath, new TextEncoder().encode("existing envelope stays unchanged")],
    [ciphertextPath, await encryptBytes(key, new TextEncoder().encode("{}"))],
  ]));
}

function expectReadOnly(calls: string[]) {
  expect(calls.some((call) => /^(put|del):/.test(call))).toBe(false);
  expect(calls).not.toContain(`get:${envelopePath}`);
}

test("recovery join verifies bucket ciphertext and adopts the key without touching its envelope", async () => {
  const { client, calls } = await encryptedBucket();
  const input = { ...config, masterKey: "stale-key" };
  const result = await resolveBucketEnrollment(
    client, input,
    { method: "recovery", recoveryCode: await encodeRecoveryCode(key) },
    new AbortController().signal,
  );
  expect(result.masterKey).toBe(toB64(key));
  expect(input.masterKey).toBe("stale-key");
  expect(calls).toContain(`get:${ciphertextPath}`);
  expectReadOnly(calls);
});

test("a valid recovery code for a different bucket is rejected", async () => {
  const { client, calls } = await encryptedBucket();
  await expect(resolveBucketEnrollment(
    client, config,
    { method: "recovery", recoveryCode: await encodeRecoveryCode(new Uint8Array(32).fill(8)) },
    new AbortController().signal,
  )).rejects.toThrow("master key does not match this bucket");
  expectReadOnly(calls);
});

test("a recovery-code checksum typo fails before bucket access", async () => {
  const { client, calls } = bucket();
  const code = await encodeRecoveryCode(key);
  const last = code.at(-1) === "A" ? "B" : "A";
  await expect(resolveBucketEnrollment(
    client, config,
    { method: "recovery", recoveryCode: code.slice(0, -1) + last },
    new AbortController().signal,
  )).rejects.toThrow("checksum");
  expect(calls).toEqual([]);
});

test("recovery joins a bucket without ciphertext just as the CLI does, without provisioning", async () => {
  const { client, calls, objects } = bucket();
  const result = await resolveBucketEnrollment(
    client, config,
    { method: "recovery", recoveryCode: await encodeRecoveryCode(key) },
    new AbortController().signal,
  );
  expect(result.masterKey).toBe(toB64(key));
  expect(objects.size).toBe(0);
  expectReadOnly(calls);
});

test("an abort while verification is in flight cannot return credentials", async () => {
  const { client, calls } = await encryptedBucket();
  const controller = new AbortController();
  const get = client.get;
  client.get = async (path) => {
    const data = await get(path);
    controller.abort();
    return data;
  };
  await expect(resolveBucketEnrollment(
    client, config,
    { method: "recovery", recoveryCode: await encodeRecoveryCode(key) },
    controller.signal,
  )).rejects.toThrow("连接已取消");
  expectReadOnly(calls);
});

test("an already aborted attempt never accesses the bucket", async () => {
  const { client, calls } = bucket();
  const controller = new AbortController();
  controller.abort();
  await expect(resolveBucketEnrollment(
    client, config, { method: "passphrase", passphrase: "test" }, controller.signal,
  )).rejects.toThrow("连接已取消");
  expect(calls).toEqual([]);
});

test("passphrase mode still unwraps an existing key envelope", async () => {
  const envelope = await wrapMasterKey(key, "test passphrase");
  const { client, calls } = bucket(new Map([
    [envelopePath, new TextEncoder().encode(JSON.stringify(envelope))],
  ]));
  const result = await resolveBucketEnrollment(
    client, config, { method: "passphrase", passphrase: "test passphrase" },
    new AbortController().signal,
  );
  expect(result.masterKey).toBe(toB64(key));
  expect(calls).toEqual([`get:${envelopePath}`]);
});

test("plaintext bucket only checks access and never carries an old master key", async () => {
  const { client, calls } = bucket();
  const result = await resolveBucketEnrollment(
    client, { ...config, encrypt: false, masterKey: "stale-key" },
    { method: "recovery", recoveryCode: "" },
    new AbortController().signal,
  );
  expect(result.masterKey).toBeUndefined();
  expect(calls).toEqual(["list:metahub/"]);
});
