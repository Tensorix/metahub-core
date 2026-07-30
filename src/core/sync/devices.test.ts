import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { setNodeLabel } from "../node.ts";
import { addPeer, addStoragePeer } from "./peers.ts";
import { mintGrant } from "./pairing.ts";
import { ingest, type Change } from "../crdt.ts";
import { formatHlc } from "../hlc.ts";
import { listDevices, resolveDevicePresence } from "./devices.ts";

function makeNode(id: string): Database {
  const db = new Database(":memory:");
  runSchema(db);
  db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run(id);
  return db;
}

/** Ingest one foreign change so `node` appears in the oplog roster. */
function seedForeignChange(db: Database, node: string, atMs: number): void {
  const c: Change = {
    dataset: "databases",
    row_id: `db_x${node}`,
    col: "name",
    value: JSON.stringify("X"),
    hlc: formatHlc({ millis: atMs, counter: 0, node }),
    node_id: node,
  };
  ingest(db, [c]);
}

test("listDevices folds oplog + peers + grants; self first; honest classification", () => {
  const db = makeNode("selfnode");
  setNodeLabel(db, "工作站");

  // paired device: outbound peer row with node id + a grant it holds on us
  addPeer(db, { url: "http://box:7777", label: "盒子", node_id: "boxnode1" });
  db.query("UPDATE peers SET last_success_at = 111 WHERE url = 'http://box:7777'").run();
  mintGrant(db, "http://box:7777", "boxnode1");

  // bucket-only device: only its ops reached us
  addStoragePeer(db, {
    url: "s3://bkt/mh",
    config: {
      endpoint: "https://e",
      region: "auto",
      bucket: "bkt",
      prefix: "mh",
      accessKeyId: "a",
      secretAccessKey: "s",
      encrypt: false,
    },
    label: "bkt",
  });
  seedForeignChange(db, "phonenod", 5_000);

  // grant with no node id → standalone row
  mintGrant(db, null, null);

  const list = listDevices(db);
  expect(list[0]!.self).toBe(true);
  expect(list[0]!.label).toBe("工作站");
  expect(list[0]!.revocable).toBe("none");

  const box = list.find((d) => d.nodeId === "boxnode1")!;
  expect(box.label).toBe("盒子");
  expect(box.revocable).toBe("yes");
  expect(box.channels.map((c) => c.kind).sort()).toEqual(["grant_in", "paired_out"]);
  expect(box.lastActivityAt).toBeGreaterThanOrEqual(111);

  const phone = list.find((d) => d.nodeId === "phonenod")!;
  expect(phone.revocable).toBe("unknown");
  expect(phone.revocationConfidence).toBe("unknown");
  expect(phone.channels).toEqual([{ kind: "oplog", ref: "", lastSeenAt: 5_000 }]);

  const anon = list.find((d) => d.nodeId === null)!;
  expect(anon.revocable).toBe("yes");
  expect(anon.channels[0]!.kind).toBe("grant_in");
});

test("an oplog-only historical device stays unknown without source evidence", () => {
  const db = makeNode("selfnode");
  seedForeignChange(db, "ghostnod", 1_000);
  const ghost = listDevices(db).find((d) => d.nodeId === "ghostnod")!;
  expect(ghost.revocable).toBe("unknown");
});

test("only explicit bucket presence upgrades an oplog-only device to bucket_rotate", () => {
  const db = makeNode("selfnode");
  seedForeignChange(db, "phone", 1_000);
  seedForeignChange(db, "historic", 2_000);
  const resolved = resolveDevicePresence(listDevices(db), [
    {
      url: "s3://actual/mh",
      nodes: [{ nodeId: "phone", inBucket: true, leaseLiveUntil: null }],
    },
    {
      url: "s3://unrelated/mh",
      nodes: [{ nodeId: "other", inBucket: true, leaseLiveUntil: null }],
    },
  ]);
  const phone = resolved.find((d) => d.nodeId === "phone")!;
  expect(phone.revocable).toBe("bucket_rotate");
  expect(phone.revocationConfidence).toBe("confirmed");
  expect(phone.revocationSources).toEqual(["s3://actual/mh"]);
  expect(phone.channels.some((c) => c.kind === "bucket_presence")).toBe(true);
  expect(resolved.find((d) => d.nodeId === "historic")!.revocable).toBe("unknown");
});

test("self with own ops keeps 'none' and carries oplog activity", () => {
  const db = makeNode("selfnode");
  seedForeignChange(db, "selfnode", 9_000);
  const self = listDevices(db)[0]!;
  expect(self.self).toBe(true);
  expect(self.revocable).toBe("none");
  expect(self.lastActivityAt).toBe(9_000);
});

test("revocationSources never carry a full grant token — 8-char prefix only", () => {
  const db = makeNode("selfnode");
  addPeer(db, { url: "http://box:7777", label: "盒子", node_id: "boxnode1" });
  const token = mintGrant(db, "http://box:7777", "boxnode1");
  expect(token.length).toBeGreaterThan(8);

  const box = listDevices(db).find((d) => d.nodeId === "boxnode1")!;
  const grantSource = box.revocationSources.find((s) => s !== "http://box:7777")!;
  expect(grantSource).toBe(token.slice(0, 8));
  // The SOURCES field must never serialize the full credential. (channels[]
  // still carries it for grant-level callers; routes mask that separately.)
  expect(JSON.stringify(box.revocationSources)).not.toContain(token);
});
