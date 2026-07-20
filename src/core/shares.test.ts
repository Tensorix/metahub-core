import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "./db.ts";
import {
  createShare,
  getShare,
  listShares,
  listSharesForTarget,
  deleteShare,
  shareExpired,
  hashSharePassword,
  verifySharePassword,
} from "./shares.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  runSchema(db);
  return db;
}

test("createShare mints a 12-char slug and round-trips", () => {
  const db = makeDb();
  const s = createShare(db, { kind: "doc", target_id: "doc_x-1" });
  expect(s.slug.length).toBe(12);
  expect(s.permission).toBe("view");
  expect(s.transport).toBe("server");
  expect(s.guest_node_id).toBeNull();
  expect(getShare(db, s.slug)).toEqual(s);
});

test("edit share mints a guest node id; view does not", () => {
  const db = makeDb();
  const edit = createShare(db, { kind: "doc", target_id: "doc_x-1", permission: "edit" });
  expect(edit.guest_node_id).toBeTruthy();
  expect(edit.guest_node_id!.startsWith("g")).toBe(true);
  const view = createShare(db, { kind: "doc", target_id: "doc_x-1" });
  expect(view.guest_node_id).toBeNull();
});

test("createShare records served_base and is server-only", () => {
  const db = makeDb();
  const s = createShare(db, { kind: "doc", target_id: "doc_x-1", servedBase: "http://host:7777" });
  expect(s.transport).toBe("server");
  expect(s.served_base).toBe("http://host:7777");
});

test("request id makes remote share creation idempotent", () => {
  const db = makeDb();
  const requestId = "share_request_1234567890";
  const first = createShare(db, {
    kind: "doc",
    target_id: "doc_x-1",
    requestId,
  });
  const retry = createShare(db, {
    kind: "doc",
    target_id: "doc_x-1",
    requestId,
  });
  expect(retry.slug).toBe(first.slug);
  expect(listShares(db)).toHaveLength(1);
  expect(() =>
    createShare(db, { kind: "doc", target_id: "doc_other", requestId }),
  ).toThrow("another target");
});

test("list / listForTarget / delete", () => {
  const db = makeDb();
  const a = createShare(db, { kind: "doc", target_id: "doc_a-1" });
  createShare(db, { kind: "site", target_id: "site_b-1" });
  expect(listShares(db).length).toBe(2);
  expect(listSharesForTarget(db, "doc_a-1").map((s) => s.slug)).toEqual([a.slug]);
  expect(deleteShare(db, a.slug)).toBe(true);
  expect(getShare(db, a.slug)).toBeNull();
  expect(deleteShare(db, a.slug)).toBe(false);
  expect(listShares(db).length).toBe(1);
});

test("shareExpired honors expires_at", () => {
  const db = makeDb();
  const never = createShare(db, { kind: "doc", target_id: "doc_a-1" });
  expect(shareExpired(never)).toBe(false);
  const past = createShare(db, { kind: "doc", target_id: "doc_b-1", expiresAt: Date.now() - 1000 });
  expect(shareExpired(past)).toBe(true);
  const future = createShare(db, { kind: "doc", target_id: "doc_c-1", expiresAt: Date.now() + 60_000 });
  expect(shareExpired(future)).toBe(false);
});

test("password verifier accepts the right password and rejects others", async () => {
  const db = makeDb();
  const { salt, hash } = await hashSharePassword("hunter2");
  const s = createShare(db, { kind: "doc", target_id: "doc_a-1", pwSalt: salt, pwHash: hash });
  expect(await verifySharePassword(s, "hunter2")).toBe(true);
  expect(await verifySharePassword(s, "wrong")).toBe(false);
});

test("verifySharePassword is a no-op when no password is set", async () => {
  const db = makeDb();
  const s = createShare(db, { kind: "doc", target_id: "doc_a-1" });
  expect(await verifySharePassword(s, "anything")).toBe(true);
});
