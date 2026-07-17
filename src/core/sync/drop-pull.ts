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
import type { Change } from "../crdt.ts";
import { getNodeId } from "../node.ts";
import { ingest } from "../crdt.ts";
import { MhError, errorCode } from "../errors.ts";
import { parseGrantSet, GUEST_LIMITS, type GrantSet } from "../grants-core.ts";
import { applyGuestIntent } from "../guest-intent.ts";
import type { AccessPolicy } from "../access-policy.ts";
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
  checkDropIntents,
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
  /** Held (NOT acked, NOT deleted) because opening failed on OUR side — a local
   *  key/bucket fault, not bad mail. Retried on a later, fixed pull; never lost. */
  held: number;
  /** Payload-version breakdown of the envelopes ingested this round — drives the
   *  drain metric for the v1→v2 migration (mh edge status). */
  v1: number;
  v2: number;
}

export interface DropPullSummary {
  skipped?: "no_edge" | "no_sites" | "no_keys" | "not_publisher";
  drops: DropPullDropSummary[];
  fetched: number;
  ingested: number;
  acked: number;
  rejected: number;
  deferred: number;
  held: number;
  v1: number;
  v2: number;
}

function emptySummary(skipped?: DropPullSummary["skipped"]): DropPullSummary {
  return { ...(skipped ? { skipped } : {}), drops: [], fetched: 0, ingested: 0, acked: 0, rejected: 0, deferred: 0, held: 0, v1: 0, v2: 0 };
}

function recordDropReject(db: DbDriver, dropId: string, envelopeId: string | null, reason: string): void {
  db.query(
    "INSERT INTO drop_rejects (drop_id, envelope_id, reason, created_at) VALUES (?, ?, ?, ?)",
  ).run(dropId, envelopeId, reason, Date.now());
  console.error(`[drop] rejected envelope ${envelopeId ?? "(unparseable)"} for ${dropId}: ${reason}`);
}

/** Max oplog seq stamped with this envelope's stable txn — a fast "have we
 *  already ingested THIS envelope_id" probe (the ordinary double-pull case),
 *  used only to skip re-decrypt. NOT the ack watermark: a new-envelope_id replay
 *  of already-held data ingests 0 rows and would leave this null forever (the
 *  old deferred-forever inbox-DoS). The ack watermark is changesMaxSeq below,
 *  keyed by the oplog UNIQUE coordinates, so a replay resolves to the ORIGINAL
 *  seq and acks normally. */
function envelopeMaxSeq(db: DbDriver, envelopeId: string): number | null {
  const r = db
    .query("SELECT MAX(seq) AS s FROM crdt_changes WHERE txn = ?")
    .get("drop:" + envelopeId) as { s: number | null };
  return r.s;
}

/** Ack watermark of a payload's ops, keyed by their register coordinates —
 *  (dataset,row_id,col) plus `hlc >= theirs`, i.e. each op counts as accounted
 *  for when it either LANDED (exact row present; the oplog UNIQUE tuple, so a
 *  new-id replay resolves to the ORIGINAL seq and acks instead of deferring
 *  forever) or was SUPERSEDED (a newer register write exists — LWW-moot, incl.
 *  a long-deferred envelope whose op was compacted away, or one applyChange
 *  rejected because a newer winner already made it un-materializable).
 *  Returns null unless EVERY op is accounted for: a partial ingest (one change
 *  skipped as poison) must NOT ack the envelope — the caller holds it and
 *  retries, because ack+delete would permanently lose that guest write.
 *  (Known limit: a held-partial envelope re-pulled after its landed sibling
 *  passed the push cursor takes the envelopeMaxSeq fast path and acks — the txn
 *  probe can't know the sealed payload's op count. Partial ingest is
 *  constructively unreachable via checkDropPayload today; this gate is the
 *  same-round backstop. Exported for the gate's unit tests.) */
export function changesMaxSeq(db: DbDriver, changes: Change[]): number | null {
  let max: number | null = null;
  for (const c of changes) {
    const r = db
      .query("SELECT MAX(seq) AS s FROM crdt_changes WHERE dataset = ? AND row_id = ? AND col = ? AND hlc >= ?")
      .get(c.dataset, c.row_id, c.col, c.hlc) as { s: number | null };
    if (r.s == null) return null; // neither landed nor superseded → not accounted for
    if (max == null || r.s > max) max = r.s;
  }
  return max;
}

/** Ack watermark for a v2 envelope: MAX oplog seq over its intents' txns
 *  ("intent:"+id). null if any intent produced no oplog rows (hold, don't ack).
 *  A replay under a new envelope_id resolves to the SAME intent txns (idempotent
 *  on intentId), so it acks instead of deferring forever — the F6 defense for v2. */
function intentsMaxSeq(db: DbDriver, intentIds: string[]): number | null {
  let max: number | null = null;
  for (const id of intentIds) {
    const r = db.query("SELECT MAX(seq) AS s FROM crdt_changes WHERE txn = ?").get("intent:" + id) as {
      s: number | null;
    };
    if (r.s == null) return null;
    if (max == null || r.s > max) max = r.s;
  }
  return max;
}

/** Apply a v2 envelope's intents (owner side), atomically. Each intent runs
 *  through the shared applyGuestIntent on the guest's own timeline (submitted
 *  clock), idempotent on intentId. Returns the ack watermark + new-row count.
 *  Throws (whole envelope rejected — a submission is atomic) on any violation. */
function applyDropV2(
  db: DbDriver,
  set: GrantSet,
  payload: { guest_node: string; intents: import("../guest-intent.ts").GuestIntent[] },
  now: number,
): { ackSeq: number | null; ingested: number } {
  const policy: AccessPolicy = {
    audience: "public",
    grants: set,
    writeGate: {},
    limits: GUEST_LIMITS,
    revision: 0,
    expiresAt: null,
    guestBase: payload.guest_node,
  };
  const before = (db.query("SELECT MAX(seq) AS s FROM crdt_changes").get() as { s: number | null }).s ?? 0;
  const ids: string[] = [];
  db.transaction(() => {
    for (const intent of payload.intents) {
      applyGuestIntent(db, policy, { guestNode: payload.guest_node }, intent, { clock: "submitted", now });
      ids.push(intent.intentId);
    }
  })();
  const ingested = (
    db.query("SELECT COUNT(*) AS n FROM crdt_changes WHERE seq > ?").get(before) as { n: number }
  ).n;
  return { ackSeq: intentsMaxSeq(db, ids), ingested };
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
  let keyringRefreshFailed = false;
  /** First dropKeySecret failure this round: the bucket master key and keyring
   *  are ROUND-shared (one bucket, one keyring), so the unwrap fault is
   *  identical for every envelope of every drop. One failed unwrap proves the
   *  whole round can't decrypt — skip the rest (no more downloads/crypto)
   *  instead of re-failing per envelope; all of it is implicitly held on the
   *  host and retried once the key is fixed. */
  let bucketKeyFault = false;
  /** Unknown key_id may mean another device rotated — refresh from the bucket
   *  once per round before giving up on an envelope. A FAILED refresh (bucket
   *  transiently unreachable) is recorded so an unknown key is HELD, not deleted
   *  as bad mail. */
  const resolveKey = async (keyId: string) => {
    let key = keyring ? findDropKey(keyring, keyId) : undefined;
    if (!key && !refreshedKeyring && bucket) {
      refreshedKeyring = true;
      try {
        keyring = await ensureDropKeys(db, { bucket });
      } catch {
        keyringRefreshFailed = true;
      }
      key = keyring ? findDropKey(keyring, keyId) : undefined;
    }
    return key;
  };
  if (!keyring && !bucket) return emptySummary("no_keys");

  const summary = emptySummary();
  for (const site of sites) {
    if (bucketKeyFault) {
      // Same bucket key serves every drop — listing/downloading more mail this
      // round would only re-fail. It all stays on the host (implicitly held).
      console.error(`[drop] skipped ${site.name}: bucket key fault (mail held on host)`);
      continue;
    }
    const s: DropPullDropSummary = {
      drop_id: site.id,
      site: site.name,
      fetched: 0,
      ingested: 0,
      acked: 0,
      rejected: 0,
      deferred: 0,
      held: 0,
      v1: 0,
      v2: 0,
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
          let ackSeq: number | null;
          if (priorSeq != null) {
            ackSeq = priorSeq;
          } else {
            const key = await resolveKey(env.key_id);
            if (!key) {
              // Unknown key while the bucket was unreachable this round: our
              // keyring may just be stale — HOLD (don't delete legit mail). A
              // resolvable-but-absent key (bogus/purged key_id) is bad mail.
              if (keyringRefreshFailed) { s.held++; continue; }
              throw new MhError("invalid_input", `unknown drop key ${env.key_id}`);
            }
            let sk: Uint8Array;
            try {
              sk = await dropKeySecret(db, key, { bucket });
            } catch {
              // Our master key can't unwrap the private half — a LOCAL fault
              // (bucket master key misconfigured / rotated wrong) that fails
              // identically for every envelope. Never delete legit mail for it:
              // hold and retry once the key is fixed. One failure proves the
              // whole round — stop paying download+crypto for the rest.
              s.held++;
              if (!bucketKeyFault) {
                bucketKeyFault = true;
                console.error(
                  `[drop] bucket master key cannot unwrap the drop keyring — holding all remaining mail this round (fix the bucket key, then re-pull)`,
                );
              }
              break;
            }
            // openSealed failing past this point is per-envelope (tampered /
            // garbage ciphertext) → the outer catch rejects+deletes it, so an
            // attacker can't pin capacity with unopenable mail.
            const payload = await openDropEnvelope(env, { pk: fromB64(key.pk), sk });
            if (payload.v === 2) {
              // v2: high-level intents, applied on the guest's own timeline by
              // the shared executor (no browser-minted HLC). Idempotent on
              // intentId; ack watermark keyed by the intent txns.
              const checked = checkDropIntents(node, payload);
              const r = applyDropV2(db, set, checked, now());
              s.ingested += r.ingested;
              s.v2++;
              ackSeq = r.ackSeq;
            } else {
              const changes = checkDropPayload(db, set, node, env.envelope_id, payload, now());
              s.ingested += ingest(db, changes);
              s.v1++;
              ackSeq = changesMaxSeq(db, changes);
            }
          }
          if (ackSeq == null) {
            // Partial ingest: at least one op neither landed nor was superseded
            // (a poison-skipped change). Ack+delete would permanently lose that
            // guest write — hold the envelope and retry next round.
            s.held++;
          } else if (!bucket) {
            ackNow.push(row.id);
          } else if (ackSeq <= bucketPushCursor(db, bucket)) {
            ackNow.push(row.id);
          } else {
            s.deferred++;
          }
        } catch (e) {
          recordDropReject(db, site.id, envelopeId, (e as Error).message);
          ackNow.push(row.id); // invalid mail: logged, then deleted immediately
          s.rejected++;
        }
      }
      if (ackNow.length) s.acked += await host.ackEnvelopes(site.id, ackNow);
      if (bucketKeyFault) break; // remaining pages would only re-fail the unwrap
      if (rows.length < PAGE_LIMIT) break;
    }
    // acked counts include rejected deletions; report net numbers as-is.
    summary.drops.push(s);
    summary.fetched += s.fetched;
    summary.ingested += s.ingested;
    summary.acked += s.acked;
    summary.rejected += s.rejected;
    summary.deferred += s.deferred;
    summary.held += s.held;
    summary.v1 += s.v1;
    summary.v2 += s.v2;
  }
  return summary;
}
