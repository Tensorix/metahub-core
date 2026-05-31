import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { readState, rotate, loadOrRotate, parseDuration } from "./token.ts";
import { type AuthConfig, hasValidToken, renewToken } from "./auth.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  runSchema(db);
  return db;
}

const DAY = 86_400_000;

function managed(db: Database): AuthConfig {
  return { debug: false, staticToken: null, db, ttlMs: 30 * DAY, graceMs: 7 * DAY };
}

function get(url: string, token?: string): [Request, URL] {
  const u = new URL(url);
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  return [new Request(u, { headers }), u];
}

test("parseDuration: units and fallback", () => {
  expect(parseDuration("30d", 0)).toBe(30 * DAY);
  expect(parseDuration("24h", 0)).toBe(24 * 3_600_000);
  expect(parseDuration("90m", 0)).toBe(90 * 60_000);
  expect(parseDuration("3600", 0)).toBe(3_600_000); // bare = seconds
  expect(parseDuration(undefined, 123)).toBe(123);
  expect(parseDuration("garbage", 123)).toBe(123);
});

test("loadOrRotate persists across calls (no churn before expiry)", () => {
  const db = makeDb();
  const a = loadOrRotate(db, 30 * DAY, 7 * DAY);
  const b = loadOrRotate(db, 30 * DAY, 7 * DAY);
  expect(b.token).toBe(a.token);
  expect(b.exp).toBe(a.exp);
  expect(readState(db)?.token).toBe(a.token);
});

test("rotate moves current → prev and mints a fresh token", () => {
  const db = makeDb();
  const first = loadOrRotate(db, 30 * DAY, 7 * DAY);
  const second = rotate(db, 30 * DAY, 7 * DAY);
  expect(second.token).not.toBe(first.token);
  expect(second.prev).toBe(first.token);
  expect(second.prevExp).toBeGreaterThan(Date.now());
});

test("expired token triggers rotation on next load", () => {
  const db = makeDb();
  const first = rotate(db, -1, 7 * DAY); // already expired
  const next = loadOrRotate(db, 30 * DAY, 7 * DAY);
  expect(next.token).not.toBe(first.token);
  expect(next.prev).toBe(first.token); // the just-expired token is now exchangeable
});

test("renewToken accepts current and in-grace prev, rejects unknown", () => {
  const db = makeDb();
  const first = loadOrRotate(db, 30 * DAY, 7 * DAY);
  rotate(db, 30 * DAY, 7 * DAY);
  const cur = readState(db)!;
  const cfg = managed(db);

  // current token → echoed back
  expect(renewToken(...get("http://x/auth/token", cur.token), cfg)?.token).toBe(cur.token);
  // in-grace previous token → swapped up to current
  expect(renewToken(...get("http://x/auth/token", first.token), cfg)?.token).toBe(cur.token);
  // unknown token → null
  expect(renewToken(...get("http://x/auth/token", "nope"), cfg)).toBeNull();
  // no token → null
  expect(renewToken(...get("http://x/auth/token"), cfg)).toBeNull();
});

test("renewToken rejects a prev token past its grace window", () => {
  const db = makeDb();
  const first = loadOrRotate(db, 30 * DAY, 7 * DAY);
  rotate(db, 30 * DAY, -1); // new grace already elapsed
  const cfg = managed(db);
  expect(renewToken(...get("http://x/auth/token", first.token), cfg)).toBeNull();
});

test("hasValidToken: managed mode gates on the current token", () => {
  const db = makeDb();
  const cfg = managed(db);
  const cur = loadOrRotate(db, 30 * DAY, 7 * DAY);
  expect(hasValidToken(...get("http://x/api/x", cur.token), cfg)).toBe(true);
  expect(hasValidToken(...get("http://x/api/x", "wrong"), cfg)).toBe(false);
});

test("static token mode: fixed, no renewal", () => {
  const cfg: AuthConfig = {
    debug: false,
    staticToken: "fixed123",
    db: null,
    ttlMs: 0,
    graceMs: 0,
  };
  expect(hasValidToken(...get("http://x/api/x", "fixed123"), cfg)).toBe(true);
  expect(hasValidToken(...get("http://x/api/x", "other"), cfg)).toBe(false);
  expect(renewToken(...get("http://x/auth/token", "fixed123"), cfg)).toBeNull();
});

test("debug mode: auth off", () => {
  const cfg: AuthConfig = { debug: true, staticToken: null, db: null, ttlMs: 0, graceMs: 0 };
  expect(hasValidToken(...get("http://x/api/x"), cfg)).toBe(true);
});
