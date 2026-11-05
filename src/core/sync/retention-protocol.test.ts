import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { assertReplicaGeneration, readReplicaGeneration, writeReplicaGeneration, parseRetentionEvent } from "./retention-protocol.ts";
import { syncWithPeer } from "./client.ts";
const generation = { protocolVersion: 2 as const, workspaceId: "workspace", epoch: 1, incarnationId: "local", checkpoint: "a".repeat(64) };
function db() { const d = new Database(":memory:"); runSchema(d); return d; }
test("legacy interoperability remains unchanged until migration", () => {
  const d = db(); try { expect(readReplicaGeneration(d)).toBeNull(); assertReplicaGeneration(d, undefined); } finally { d.close(); }
});
test("generation guards reject legacy, foreign and rolled-back state", () => {
  const d = db(); try {
    writeReplicaGeneration(d, generation);
    assertReplicaGeneration(d, { ...generation, incarnationId: "remote" });
    expect(() => writeReplicaGeneration(d, { ...generation, checkpoint: "b".repeat(64) })).toThrow("checkpoint cannot change");
    expect(readReplicaGeneration(d)).toEqual(generation);
    expect(() => assertReplicaGeneration(d, undefined)).toThrow("version 2");
    expect(() => assertReplicaGeneration(d, { ...generation, epoch: 0 })).toThrow("obsolete");
    expect(() => writeReplicaGeneration(d, { ...generation, epoch: 0 })).toThrow("roll back");
    expect(() => writeReplicaGeneration(d, { ...generation, workspaceId: "foreign" })).toThrow("roll back");
  } finally { d.close(); }
});
test("v2 peer refuses a legacy endpoint before uploading anything", async () => {
  const d = db(); try {
    writeReplicaGeneration(d, generation);
    const requests: string[] = [];
    await expect(syncWithPeer(d, "https://peer.invalid", { fetch: (async (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      return Response.json({ ok: true });
    }) as typeof fetch })).rejects.toMatchObject({ code: "upgrade_required" });
    expect(requests).toEqual(["GET /health"]);
  } finally { d.close(); }
});
test("untrusted retention events reject extra fields and invalid counters", () => {
  expect(() => parseRetentionEvent({ type: "clock", epoch: 9 })).toThrow();
  expect(() => parseRetentionEvent({ type: "batch", epoch: 0, member: "a", first: 1, last: 1.5, objectHash: "a".repeat(64) })).toThrow();
});

test("HTTP checkpoint race returns rebootstrap_required without advancing cursors", async () => {
  const d = db();
  try {
    writeReplicaGeneration(d,generation);
    await expect(syncWithPeer(d,"https://peer.invalid",{ fetch: (async url => {
      if (new URL(String(url)).pathname === "/health") return Response.json({ ok: true, generation });
      return Response.json({ code: "rebootstrap_required", error: "checkpoint advanced" },{ status: 409 });
    }) as typeof fetch })).rejects.toMatchObject({ code: "rebootstrap_required" });
    expect(d.query("SELECT push_cursor,pull_cursor FROM peers").all().every((row: any) => row.push_cursor === 0 && row.pull_cursor === 0)).toBe(true);
  } finally { d.close(); }
});
