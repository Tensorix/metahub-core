// The owner-side pull loop of the write-inbox: fetch sealed envelopes from the
// edge host, decrypt, run the isolation check (drop-protocol.checkDropPayload),
// ingest the pre-signed guest ops, and acknowledge (delete) what is safely
// landed. The inbox is NOT a sync source — data's only home is the oplog; an
// envelope is mail until it clears the isolation layer.
//
// Idempotency contract ("double pull is harmless"): the oplog's
// UNIQUE(dataset,row_id,col,hlc) plus the stable "drop:"+envelope_id txn make a
// re-pull a no-op (ingest returns inserted:0), after which the pending ack is
// simply retried — so there is NO cursor state table for the inbox at all.
//
// Ack gating: with a bucket attached, an envelope is only deleted once its ops
// are BOTH in the local oplog and covered by the bucket push cursor (the drop
// round runs after the bucket round each tick, so a healthy pipeline acks one
// round later at worst). Without a bucket, landing in the local oplog is the
// durability anchor — ack immediately. Invalid envelopes are recorded in the
// node-local drop_rejects table and deleted right away (garbage must not eat
// inbox capacity, and it never touches the oplog).

import type { DbDriver } from "../driver.ts";
import { getNodeId } from "../node.ts";
import { ingest } from "../crdt.ts";
import { errorCode } from "../errors.ts";
import { parseGrantSet } from "../grants-core.ts";
import { listSites, type SiteRow } from "../sites-core.ts";
import { getEdgeConfig } from "./edge-config.ts";
import { httpDropHost, type DropHostApi } from "./drop-host.ts";
import {
  getLocalDropKeyring,
  ensureDropKeys,
  findDropKey,
  dropKeySecret,
  dropBucketFor,
  type DropKeyring,
  type DropBucket,
} from "./drop-keys.ts";
import {
  parseDropEnvelope,
  openDropEnvelope,
  checkDropPayload,
} from "./drop-protocol.ts";
import { fromB64 } from "./e2ee.ts";
import { isElectedPublisher } from "./publisher-lease.ts";

const PAGE_LIMIT = 100;

/** Live sites that expose a `create` grant — exactly the sites the auto-wiring
 *  registers as drops, so this derivation IS the drop inventory (no extra
 *  registry to keep in sync). */
export function dropWiredSites(db: DbDriver): SiteRow[] {
  return listSites(db).filter((s) =>
    parseGrantSet(s.public_grants).tables.some((t) => t.ops.includes("create")),
  );
}

export interface DropPullDropSummary {
  drop_id: string;
  site: string;
  /** Envelopes fetched this round. */
  fetched: number;
  /** New oplog rows gained (ingest's honest "received" count). */
  ingested: number;
  acked: number;
  rejected: number;
  /** Valid + ingested but ack deferred to a later round (bucket gate). */
  deferred: number;
}

export interface DropPullSummary {
  skipped?: "no_edge" | "no_sites" | "no_keys" | "not_publisher";
  drops: DropPullDropSummary[];
  fetched: number;
  ingested: number;
  acked: number;
  rejected: number;
  deferred: number;
}

function emptySummary(skipped?: DropPullSummary["skipped"]): DropPullSummary {
  return { ...(skipped ? { skipped } : {}), drops: [], fetched: 0, ingested: 0, acked: 0, rejected: 0, deferred: 0 };
}

function recordDropReject(db: DbDriver, dropId: string, envelopeId: string | null, reason: string): void {
  db.query(
    "INSERT INTO drop_rejects (drop_id, envelope_id, reason, created_at) VALUES (?, ?, ?, ?)",
  ).run(dropId, envelopeId, reason, Date.now());
  console.error(`[drop] rejected envelope ${envelopeId ?? "(unparseable)"} for ${dropId}: ${reason}`);
}

/** Max oplog seq of one envelope's ingested ops (keyed by the stable txn) —
 *  the precise "what must the bucket have pushed past" ack watermark; stays
 *  correct across re-pulls and concurrent local edits. */
function envelopeMaxSeq(db: DbDriver, envelopeId: string): number | null {
  const r = db
    .query("SELECT MAX(seq) AS s FROM crdt_changes WHERE txn = ?")
    .get("drop:" + envelopeId) as { s: number | null };
  return r.s;
}

function bucketPushCursor(db: DbDriver, bucket: DropBucket): number {
  const r = db.query("SELECT push_cursor FROM peers WHERE url = ?").get(bucket.peerUrl) as
    | { push_cursor: number }
    | null;
  return r?.push_cursor ?? 0;
}

/**
 * One pull round over every wired drop. With a bucket attached the round rides
 * the publisher lease (only the elected device pays the poll — correctness
 * never depends on it, double pulls converge); `ignoreLease` (manual
 * `mh edge pull`) skips that economy.
 */
export async function pullDropsOnce(
  db: DbDriver,
  opts: { host?: DropHostApi; ignoreLease?: boolean; now?: () => number } = {},
): Promise<DropPullSummary> {
  const cfg = getEdgeConfig(db);
  if (!cfg) return emptySummary("no_edge");
  const sites = dropWiredSites(db);
  if (sites.length === 0) return emptySummary("no_sites");

  const node = getNodeId(db);
  const now = opts.now ?? (() => Date.now());
  const host = opts.host ?? httpDropHost(cfg.endpoint, cfg.token);
  const bucket = dropBucketFor(db);

  if (bucket && !opts.ignoreLease) {
    const elected = await isElectedPublisher(
      bucket.client(),
      bucket.base,
      node,
      bucket.config.priority ?? 0,
    );
    if (!elected) return emptySummary("not_publisher");
  }

  let keyring: DropKeyring | null = getLocalDropKeyring(db);
  let refreshedKeyring = false;
  /** Unknown key_id may mean another device rotated — refresh from the bucket
   *  once per round before giving up on an envelope. */
  const resolveKey = async (keyId: string) => {
    let key = keyring ? findDropKey(keyring, keyId) : undefined;
    if (!key && !refreshedKeyring && bucket) {
      refreshedKeyring = true;
      keyring = await ensureDropKeys(db, { bucket }).catch(() => keyring);
      key = keyring ? findDropKey(keyring, keyId) : undefined;
    }
    return key;
  };
  if (!keyring && !bucket) return emptySummary("no_keys");

  const summary = emptySummary();
  for (const site of sites) {
    const s: DropPullDropSummary = {
      drop_id: site.id,
      site: site.name,
      fetched: 0,
      ingested: 0,
      acked: 0,
      rejected: 0,
      deferred: 0,
    };
    const set = parseGrantSet(site.public_grants);
    let afterId = 0;
    for (;;) {
      let rows;
      try {
        rows = await host.listEnvelopes(site.id, afterId, PAGE_LIMIT);
      } catch (e) {
        // An unregistered drop (fresh host, registration pending) is a quiet
        // skip; real transport errors surface to the caller's error handling.
        if (errorCode(e) === "not_found") break;
        throw e;
      }
      if (rows.length === 0) break;
      const ackNow: number[] = [];
      for (const row of rows) {
        afterId = Math.max(afterId, row.id);
        s.fetched++;
        let envelopeId: string | null = null;
        try {
          const env = parseDropEnvelope(row.envelope);
          envelopeId = env.envelope_id;
          if (env.drop_id !== site.id) throw new Error("envelope drop_id mismatch");
          // Replay of an envelope we already ingested (its stable txn is in the
          // oplog): skip decrypt + validation — re-running checkDropPayload
          // would misread our own materialized row as a guest "update" — and
          // fall straight through to the ack gate (the 未 ack 重拉 → 补 ack path).
          const priorSeq = envelopeMaxSeq(db, env.envelope_id);
          if (priorSeq == null) {
            const key = await resolveKey(env.key_id);
            if (!key) throw new Error(`unknown drop key ${env.key_id}`);
            const sk = await dropKeySecret(db, key, { bucket });
            const payload = await openDropEnvelope(env, { pk: fromB64(key.pk), sk });
            const changes = checkDropPayload(db, set, node, env.envelope_id, payload, now());
            s.ingested += ingest(db, changes);
          }
          if (!bucket) {
            ackNow.push(row.id);
          } else {
            const seqAtIngest = envelopeMaxSeq(db, env.envelope_id);
            if (seqAtIngest != null && seqAtIngest <= bucketPushCursor(db, bucket)) ackNow.push(row.id);
            else s.deferred++;
          }
        } catch (e) {
          recordDropReject(db, site.id, envelopeId, (e as Error).message);
          ackNow.push(row.id); // invalid mail: logged, then deleted immediately
          s.rejected++;
        }
      }
      if (ackNow.length) s.acked += await host.ackEnvelopes(site.id, ackNow);
      if (rows.length < PAGE_LIMIT) break;
    }
    // acked counts include rejected deletions; report net numbers as-is.
    summary.drops.push(s);
    summary.fetched += s.fetched;
    summary.ingested += s.ingested;
    summary.acked += s.acked;
    summary.rejected += s.rejected;
    summary.deferred += s.deferred;
  }
  return summary;
}
