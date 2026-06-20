import { test, expect } from "bun:test";
import { scopesFor } from "./scopes.ts";
import type { ClientMode } from "./replica.ts";

const M = (
  surface: ClientMode["surface"],
  dataHome: ClientMode["dataHome"],
  hold: ClientMode["hold"],
): ClientMode => ({ surface, dataHome, hold });

const ALL: ClientMode[] = [
  M("web", "server", "window"), // thin
  M("web", "server", "replica"), // offline-replica / homelab
  M("web", "local", "replica"), // bucket-replica (no-origin)
  M("desktop", "server", "window"), // sidecar
  M("cli", "server", "window"), // cli (reserved)
];

test("thin (window+server): one cloud-workspace scope, no choice", () => {
  const s = scopesFor(M("web", "server", "window"));
  expect(s.map((x) => x.kind)).toEqual(["server"]);
  expect(s[0]!.label).toBe("云端工作区");
});

test("offline-replica (replica+server): [local, server], default local — the 2-switch case", () => {
  const s = scopesFor(M("web", "server", "replica"));
  expect(s.map((x) => x.kind)).toEqual(["local", "server"]);
  expect(s[0]!.kind).toBe("local");
  expect(s[0]!.label).toBe("本机");
});

test("bucket-replica (no-origin): [local] only", () => {
  const s = scopesFor(M("web", "local", "replica"));
  expect(s.map((x) => x.kind)).toEqual(["local"]);
  expect(s[0]!.label).toBe("本机");
});

test("desktop sidecar: single server scope labelled 本机工作区 (no on-device double-store)", () => {
  const s = scopesFor(M("desktop", "server", "window"));
  expect(s.map((x) => x.kind)).toEqual(["server"]);
  expect(s[0]!.label).toBe("本机工作区");
});

test("desktop never emits a local scope even if hold happens to read replica", () => {
  expect(scopesFor(M("desktop", "server", "replica")).map((x) => x.kind)).toEqual(["server"]);
});

test("every mode: non-empty, exactly one default, default is index 0", () => {
  for (const m of ALL) {
    const s = scopesFor(m);
    expect(s.length).toBeGreaterThan(0);
    expect(s.filter((x) => x.isDefault)).toHaveLength(1);
    expect(s[0]!.isDefault).toBe(true);
  }
});

test("storage-management filter (drop buckets) leaves the user's expected switch counts", () => {
  const storage = (m: ClientMode) => scopesFor(m).filter((s) => s.kind !== "bucket");
  expect(storage(M("web", "server", "window")).length).toBe(1); // thin → 1 (no switch)
  expect(storage(M("web", "server", "replica")).length).toBe(2); // offline-replica → 2 (one switch)
});

test("no user-facing string leaks an engineering term", () => {
  const reject = /window|replica|datahome|hold|opfs|origin|bucket|s3|peer|publisher|snapshot|oplog/i;
  for (const m of ALL) {
    for (const s of scopesFor(m)) {
      expect(s.label).not.toMatch(reject);
      expect(s.subtitle).not.toMatch(reject);
    }
  }
});
