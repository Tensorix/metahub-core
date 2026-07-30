import { test, expect } from "bun:test";
import { dataMapIssueLines, dataMapTone, selfPlaceCopy } from "./data-map-status.ts";
import type { ClientMode } from "./data/replica.ts";
import type { DataMap } from "./api.ts";

const mode = (over: Partial<ClientMode>): ClientMode => ({
  surface: "web",
  dataHome: "server",
  hold: "window",
  ...over,
});

test("window-mode browser: the map's self is the workspace primary, not this browser", () => {
  const thin = selfPlaceCopy(mode({}));
  expect(thin.kindLabel).toBe("工作区主节点");
  expect(thin.labelOverride).toBe("工作区主节点");
});

test("desktop sidecar: self reads as the machine-local workspace", () => {
  const sidecar = selfPlaceCopy(mode({ surface: "desktop" }));
  expect(sidecar.kindLabel).toBe("本机工作区");
});

test("replica modes: the map IS computed here — 本机 stays correct", () => {
  const offline = selfPlaceCopy(mode({ hold: "replica" }));
  expect(offline.kindLabel).toBe("本机");
  expect(offline.labelOverride).toBeNull();
  const bucket = selfPlaceCopy(mode({ dataHome: "local", hold: "replica" }));
  expect(bucket.kindLabel).toBe("本机");
});

const mapWith = (issues: DataMap["state"]["issues"], state: DataMap["state"]["state"]): DataMap =>
  ({
    state: {
      state,
      places: 1,
      pendingBlobCount: 0,
      pendingBlobBytes: 0,
      pendingChanges: 0,
      oldestSyncedAt: null,
      issues,
    },
    places: [],
  }) as DataMap;

test("issue lines carry place + label + message; none when healthy", () => {
  const m = mapWith(
    [
      { kind: "peer_error", placeUrl: "s3://b/x", placeLabel: "我的 R2", message: "wrong key" },
      { kind: "behind", placeUrl: "http://box", placeLabel: "盒子", message: null },
    ],
    "peer_error",
  );
  const lines = dataMapIssueLines(m);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe("我的 R2：同步失败 — wrong key");
  expect(lines[1]).toBe("盒子：有改动尚未同步");
  expect(dataMapIssueLines(mapWith([], "healthy"))).toHaveLength(0);
});

test("tone: any peer_error issue forces error even if the headline differs", () => {
  expect(dataMapTone(mapWith([], "healthy"))).toBe("ok");
  expect(
    dataMapTone(
      mapWith(
        [{ kind: "peer_error", placeUrl: null, placeLabel: null, message: null }],
        "unsynced_changes",
      ),
    ),
  ).toBe("error");
});
