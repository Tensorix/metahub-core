import { test, expect } from "bun:test";
import {
  dataPlaces,
  dataMapState,
  type DataMapInput,
  type DataMapPeerInput,
} from "./data-map.ts";

const base = (over: Partial<DataMapInput> = {}): DataMapInput => ({
  selfNodeId: "selfnode",
  selfLabel: null,
  peers: [],
  pendingBlobCount: 0,
  pendingBlobBytes: 0,
  blobFullNodes: [],
  globalHighWaterSeq: 0,
  ownHighWaterSeq: 0,
  staleAfterMs: 200_000,
  now: 1_000_000,
  ...over,
});

const httpPeer = (over: Partial<DataMapPeerInput> = {}): DataMapPeerInput => ({
  url: "https://box.local:7777",
  kind: "http",
  label: "家里盒子",
  nodeId: "boxnode1",
  enabled: true,
  lastSuccessAt: 900_000,
  lastStatus: "ok",
  lastError: null,
  pushCursor: 0,
  ...over,
});

const s3Peer = (over: Partial<DataMapPeerInput> = {}): DataMapPeerInput => ({
  url: "s3://bkt/metahub",
  kind: "s3",
  label: null,
  nodeId: null,
  enabled: true,
  lastSuccessAt: 800_000,
  lastStatus: "ok",
  lastError: null,
  pushCursor: 0,
  bucket: "bkt",
  publish: true,
  ...over,
});

test("lone node → no_backup, single self place", () => {
  const s = dataMapState(base());
  expect(s.state).toBe("no_backup");
  expect(s.places).toBe(1);
  const places = dataPlaces(base());
  expect(places).toHaveLength(1);
  expect(places[0]!.kind).toBe("self");
  expect(places[0]!.freshness).toBe("live");
});

test("server + bucket both synced → healthy, 3 places, oldest success anchors freshness", () => {
  const input = base({ peers: [httpPeer(), s3Peer()] });
  const s = dataMapState(input);
  expect(s.state).toBe("healthy");
  expect(s.places).toBe(3);
  expect(s.oldestSyncedAt).toBe(800_000);
  const places = dataPlaces(input);
  expect(places.map((p) => p.kind)).toEqual(["self", "device", "bucket"]);
  expect(places[2]!.roles).toContain("publisher");
  expect(places[2]!.roles).toContain("backend");
});

test("peer error outranks syncing; error place with prior success still counts as a place", () => {
  const input = base({
    peers: [
      httpPeer({ lastStatus: "error", lastError: "auth", lastSuccessAt: 700_000 }),
      s3Peer({ lastSuccessAt: null, lastStatus: null }),
    ],
  });
  const s = dataMapState(input);
  expect(s.state).toBe("peer_error");
  expect(s.places).toBe(2); // self + errored-but-previously-synced device
  const err = dataPlaces(input).find((p) => p.kind === "device")!;
  expect(err.freshness).toBe("error");
  expect(err.error).toBe("auth");
});

test("a failing peer headlines over pending blobs; both stay visible as issues", () => {
  const input = base({
    peers: [httpPeer({ lastStatus: "error", lastError: "network" })],
    pendingBlobCount: 2,
    pendingBlobBytes: 1234,
  });
  const s = dataMapState(input);
  // A hard error is the headline (it blocks the pending blobs from ever
  // draining to that target); the blob risk is not lost — it's an issue.
  expect(s.state).toBe("peer_error");
  expect(s.pendingBlobCount).toBe(2);
  expect(s.pendingBlobBytes).toBe(1234);
  expect(s.issues.map((i) => i.kind)).toEqual(["peer_error", "pending_blobs"]);
});

test("never-synced + erroring peer shows error, not a fake 'first sync in progress'", () => {
  const input = base({
    peers: [s3Peer({ lastSuccessAt: null, lastStatus: "error", lastError: "wrong credentials" })],
  });
  const s = dataMapState(input);
  expect(s.state).toBe("peer_error");
  const place = dataPlaces(input)[1]!;
  expect(place.freshness).toBe("error");
  expect(place.error).toBe("wrong credentials");
  expect(s.issues[0]).toMatchObject({ kind: "peer_error", message: "wrong credentials" });
});

test("one failing peer + one lagging peer: error headlines, lag stays an issue", () => {
  const input = base({
    globalHighWaterSeq: 12,
    peers: [
      httpPeer({ lastStatus: "error", lastError: "offline" }),
      httpPeer({ url: "https://other.local", label: "另一台", nodeId: "boxnode2", pushCursor: 9 }),
    ],
  });
  const s = dataMapState(input);
  expect(s.state).toBe("peer_error");
  expect(s.pendingChanges).toBeGreaterThan(0);
  expect(s.issues.map((i) => i.kind)).toContain("peer_error");
  expect(s.issues.map((i) => i.kind)).toContain("behind");
});

test("configured but never-synced peer → syncing; disabled peers are ignored", () => {
  const onlyNever = base({ peers: [s3Peer({ lastSuccessAt: null, lastStatus: null })] });
  expect(dataMapState(onlyNever).state).toBe("syncing");
  expect(dataMapState(onlyNever).places).toBe(1);

  const onlyDisabled = base({ peers: [s3Peer({ enabled: false })] });
  expect(dataMapState(onlyDisabled).state).toBe("no_backup");
  expect(dataPlaces(onlyDisabled).find((p) => p.kind === "bucket")!.freshness).toBe("disabled");
});

test("blob anchor roles: bucket by url, device by node id, self by own id", () => {
  const input = base({
    peers: [httpPeer(), s3Peer()],
    blobFullNodes: ["s3://bkt/metahub", "boxnode1", "selfnode"],
  });
  const places = dataPlaces(input);
  expect(places[0]!.roles).toEqual(["replica", "blob_anchor"]);
  expect(places.find((p) => p.kind === "device")!.roles).toContain("blob_anchor");
  expect(places.find((p) => p.kind === "bucket")!.roles).toContain("blob_anchor");
});

test("labels: peer label wins, bucket name falls back, then url host", () => {
  const input = base({
    peers: [
      s3Peer({ label: "我的 R2" }),
      s3Peer({ url: "s3://other/pfx", label: null, bucket: "other" }),
      httpPeer({ label: null }),
    ],
  });
  const labels = dataPlaces(input).map((p) => p.label);
  expect(labels).toContain("我的 R2");
  expect(labels).toContain("other");
  expect(labels).toContain("box.local:7777");
});

// Guards the "genuinely unpushed local edit" signal. Rows merely PULLED from
// the peer no longer create this lag — client.ts's advanceAckedPrefix moves the
// push cursor past them at sync time (see client.test.ts), so a lag here means
// real local work the peer hasn't seen.
test("a local edit after the last acknowledgement is not reported healthy", () => {
  const input = base({
    globalHighWaterSeq: 12,
    ownHighWaterSeq: 12,
    peers: [httpPeer({ pushCursor: 9 })],
  });
  const state = dataMapState(input);
  expect(state.state).toBe("unsynced_changes");
  expect(state.pendingChanges).toBe(3);
  expect(state.places).toBe(1);
  expect(dataPlaces(input)[1]).toMatchObject({
    freshness: "behind",
    acknowledgedSeq: 9,
    highWaterSeq: 12,
    lag: 3,
  });
});

test("S3 compares its cursor with own-node high-water, not foreign pulled rows", () => {
  const input = base({
    globalHighWaterSeq: 50,
    ownHighWaterSeq: 7,
    peers: [s3Peer({ pushCursor: 7 })],
  });
  expect(dataMapState(input).state).toBe("healthy");
  expect(dataPlaces(input)[1]).toMatchObject({
    freshness: "current",
    highWaterSeq: 7,
  });
});

test("an acknowledged but old confirmation is stale", () => {
  const input = base({
    now: 1_000_000,
    staleAfterMs: 50_000,
    peers: [httpPeer({ lastSuccessAt: 900_000 })],
  });
  expect(dataMapState(input).state).toBe("stale");
  expect(dataPlaces(input)[1]!.freshness).toBe("stale");
});
