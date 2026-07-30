import { test, expect } from "bun:test";
import { statusHead } from "./status.ts";
import { versionWarning } from "../../core/sync/peers.ts";
import type { DataMapState } from "../../core/data-map.ts";

const state = (over: Partial<DataMapState> = {}): { state: DataMapState } => ({
  state: {
    state: "healthy",
    places: 2,
    pendingBlobCount: 0,
    pendingBlobBytes: 0,
    pendingChanges: 0,
    oldestSyncedAt: 900_000,
    issues: [],
    ...over,
  },
});

test("healthy: no issues, no tip", () => {
  const r = statusHead(state(), 1_000_000);
  expect(r.head).toContain("Data in 2 place(s)");
  expect(r.issueLines).toEqual([]);
  expect(r.tip).toBeNull();
});

test("failing target: tip points at config, not a doomed `mh sync`", () => {
  const r = statusHead(
    state({
      state: "peer_error",
      issues: [{ kind: "peer_error", placeUrl: "s3://b/x", placeLabel: "桶", message: "auth" }],
    }),
    1_000_000,
  );
  expect(r.head).toContain("FAILING");
  expect(r.tip).toContain("mh config show");
  expect(r.tip).not.toMatch(/^\(run `mh sync` to sync now\)$/);
});

test("several concurrent issues: each gets its own line, nothing masked", () => {
  const r = statusHead(
    state({
      state: "peer_error",
      issues: [
        { kind: "peer_error", placeUrl: "s3://b/x", placeLabel: "桶", message: "auth" },
        { kind: "behind", placeUrl: "http://box", placeLabel: "盒子", message: null },
      ],
    }),
    1_000_000,
  );
  expect(r.issueLines).toHaveLength(2);
  expect(r.issueLines[0]).toContain("桶: peer_error — auth");
  expect(r.issueLines[1]).toContain("盒子: behind");
});

test("plain lag: `mh sync` is the right tip", () => {
  const r = statusHead(
    state({
      state: "unsynced_changes",
      issues: [{ kind: "behind", placeUrl: "http://box", placeLabel: "盒子", message: null }],
    }),
    1_000_000,
  );
  expect(r.issueLines).toEqual([]); // single issue = already the headline
  expect(r.tip).toContain("mh sync");
});

// ── mixed-version warning (sync handshake) ────────────────────────────────────

test("versionWarning: missing capability is the loud case", () => {
  const w = versionWarning("1.9.0", { ok: true, node: "n", capabilities: ["inbox"], version: "1.2.0" });
  expect(w).toContain("不支持站点渠道");
});

test("versionWarning: version drift warns; same version or no data stays quiet", () => {
  expect(
    versionWarning("1.9.0", { ok: true, node: "n", capabilities: ["site_channels"], version: "1.8.0" }),
  ).toContain("1.8.0");
  expect(
    versionWarning("1.9.0", { ok: true, node: "n", capabilities: ["site_channels"], version: "1.9.0" }),
  ).toBeNull();
  expect(versionWarning("1.9.0", null)).toBeNull();
  expect(versionWarning("1.9.0", { ok: true, node: "n" })).toBeNull();
});
