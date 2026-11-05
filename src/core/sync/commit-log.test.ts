import { test, expect } from "bun:test";
import { createCommitLog, commitHash } from "./commit-log.ts";
import { MhError } from "../errors.ts";
import type { StorageClient, StorageReadResult } from "./storage.ts";

function fixture() {
  const objects = new Map<string, StorageReadResult>();
  let clock = 1000;
  const client: StorageClient = {
    conditionalCreateCapability: async () => true,
    list: async () => { throw new Error("LIST must not determine correctness"); },
    get: async k => objects.get(k)?.bytes ?? null,
    getWithMetadata: async k => objects.get(k) ?? null,
    put: async (k, bytes, opts) => {
      expect(opts?.ifNoneMatch).toBe(true);
      if (objects.has(k)) throw new MhError("conflict", "occupied");
      const time = ++clock;
      objects.set(k, { bytes, serverDate: time, lastModified: time, etag: null });
    },
    del: async () => { throw new Error("control records must never be deleted"); },
  };
  const log = () => createCommitLog({ client, prefix: "v2", workspaceId: "test",
    codec: {
      encode: async v => new TextEncoder().encode(JSON.stringify(v)),
      decode: async b => JSON.parse(new TextDecoder().decode(b)),
    },
    initialState: () => 0,
    parsePayload: v => { if (!Number.isSafeInteger(v)) throw new Error("invalid"); return v as number; },
    reduce: (state, value) => state + value,
  });
  return { client, objects, log };
}

test("concurrent committers serialize and request retries are idempotent", async () => {
  const f = fixture();
  await Promise.all([f.log().append("a", () => 1), f.log().append("b", () => 2)]);
  expect((await f.log().read()).state).toBe(3);
  expect((await f.log().read()).sequence).toBe(2);
  await f.log().append("a", () => 100);
  expect((await f.log().read()).state).toBe(3);
});

test("a hidden committed slot causes a retry, never an overwrite", async () => {
  const f = fixture(), read = f.client.getWithMetadata!;
  f.client.getWithMetadata = async () => null;
  await expect(f.log().append("a", () => 1)).rejects.toMatchObject({ code: "busy" });
  expect(f.objects.size).toBe(1);
  f.client.getWithMetadata = read;
  expect((await f.log().append("a", () => 1)).state).toBe(1);
});

test("unverifiable time and chain tampering fail closed", async () => {
  const f = fixture();
  await f.log().append("a", () => 1);
  const first = [...f.objects.values()][0]!;
  first.serverDate = null;
  await expect(f.log().read()).rejects.toMatchObject({ code: "clock_skew" });
  first.serverDate = first.lastModified;
  first.bytes = new TextEncoder().encode(JSON.stringify({ protocolVersion: 2, workspaceId: "test", sequence: 2, previous: null, requestId: "a", payload: 1 }));
  await expect(f.log().read()).rejects.toMatchObject({ code: "conflict" });
});

test("unsupported conditional creation never writes", async () => {
  const f = fixture(); f.client.conditionalCreateCapability = async () => false;
  await expect(f.log().append("a", () => 1)).rejects.toMatchObject({ code: "invalid_input" });
  expect(f.objects.size).toBe(0);
});


test("deadline crossed during PUT is a rejected no-op rather than a poisoned chain", async () => {
  const f = fixture();
  const make = () => createCommitLog({ client: f.client, prefix: "deadline", workspaceId: "test",
    codec: { encode: async v => new TextEncoder().encode(JSON.stringify(v)), decode: async b => JSON.parse(new TextDecoder().decode(b)) },
    initialState: () => 0,
    parsePayload: v => Number(v),
    reduce: (s, value, at) => {
      if (value === 1 && at > 1000) throw new MhError("conflict", "deadline elapsed");
      return s + value;
    },
  });
  await expect(make().append("expired", () => 1)).rejects.toThrow("deadline elapsed");
  expect((await make().read()).state).toBe(0);
  expect((await make().append("next", () => 2)).state).toBe(2);
  await expect(make().append("expired", () => 1)).rejects.toThrow("deadline elapsed");
});

test("verified immutable slots are reused while absent slots are always re-read", async () => {
  const f = fixture(), read = f.client.getWithMetadata!;
  let reads = 0;
  f.client.getWithMetadata = async (key, options) => { reads++; return read(key, options); };
  const log = f.log();
  await log.append("a", () => 1);
  reads = 0;
  expect((await log.read()).state).toBe(1);
  expect(reads).toBe(1);
  await f.log().append("b", () => 2);
  reads = 0;
  expect((await log.read()).state).toBe(3);
  expect(reads).toBe(2);
});


test("more than ten thousand committed records do not exhaust contention retries", async () => {
  const f = fixture();
  let previous: string | null = null;
  for (let sequence = 1; sequence <= 10001; sequence++) {
    const bytes = new TextEncoder().encode(JSON.stringify({ protocolVersion: 2, workspaceId: "test", sequence,
      previous, requestId: `seed-${sequence}`, payload: 1 }));
    f.objects.set(`v2/control/${String(sequence).padStart(16,"0")}.commit`, { bytes, serverDate: 1000, lastModified: 1000, etag: null });
    previous = await commitHash(bytes);
  }
  const head = await f.log().append("after-long-history", () => 1);
  expect(head.sequence).toBe(10002);
  expect(head.state).toBe(10002);
});
