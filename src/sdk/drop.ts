// Browser-side write-drop client, bundled into /metahub-sdk.js. A public site
// page discovers `mh-drop.json` (published by the grant auto-wiring), mints a
// persistent per-visitor guest identity, authors PRE-SIGNED ops under a
// mini-HLC, seals them to the owner's public key (MH-SEAL-P256) and POSTs the
// envelope to the inbox host. The owner's device decrypts, validates and
// ingests on its next sync round — write = confirmed immediately + optimistic
// local echo; reading OTHERS' submissions stays minute-grade by design.
//
// Site authors normally never touch this module directly: sdk/client.ts uses
// it for static-async deployments, explicit live inbox fallback, and legacy
// no-manifest sites carrying mh-drop.json. It is exported for pages that want
// the pending/merge optimistic-echo helpers or Turnstile/password wiring.

import { MhError } from "../core/errors.ts";
import { randomSuffix } from "../core/ids.ts";
import type { MhErrorCode } from "../core/errors.ts";
import { toB64, fromB64, deriveShareKey } from "../core/sync/e2ee.ts";
import {
  newGuestNode,
  sealDropEnvelope,
  GUEST_NODE_RE,
  type AnyDropPayload,
} from "../core/sync/drop-protocol.ts";
import type { GuestIntent } from "../core/guest-intent.ts"; // type-only: no runtime pull
import type { Change } from "../core/crdt.ts";

// ---- published config ----------------------------------------------------------------

export interface DropPropertyInfo {
  id: string;
  name: string;
  type: string;
}

export interface DropDatabaseInfo {
  id: string;
  name: string;
  properties: DropPropertyInfo[];
}

/** Shape of the auto-published mh-drop.json (core/sync/drop-wire.ts). */
export interface DropConfig {
  v: 1;
  endpoint: string;
  drop_id: string;
  key_id: string;
  /** base64 raw P-256 public key envelopes are sealed to. */
  pk: string;
  turnstile_sitekey?: string;
  password_salt?: string;
  /** Payload wire versions the owner accepts. Absent → [1] (legacy). The SDK
   *  seals v2 (high-level GuestIntent, no browser-minted HLC) only when 2 is
   *  listed — the owner flips this after upgrading, closing the transition. */
  payload_versions?: number[];
  /** Offline schema of the create-granted tables (ops address property IDs). */
  databases?: DropDatabaseInfo[];
}

/** A locally-echoed record: RecordInfo-shaped (id/database_id/values/cells)
 *  plus `_pending: true` — render it with a "visible to everyone shortly"
 *  affordance until merge() sees the server-side row and reconciles it away. */
export interface PendingRecord {
  id: string;
  database_id: string;
  values: Record<string, unknown>;
  cells: Record<string, unknown>;
  _pending: true;
  envelope_id: string;
  created_at: number;
}

export interface DropClientOptions {
  /** Submission password, when the grant set one (mh-drop.json carries the salt). */
  password?: string;
  /** Storage for guest identity / clock / pending echoes; defaults to
   *  localStorage, falling back to an in-memory map (non-DOM contexts). */
  storage?: DropStorage;
  fetcher?: typeof fetch;
  now?: () => number;
}

export interface DropStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Derive the proof sent as x-drop-pass from a user password and the public
 *  salt. Shared by the async inbox client and the live SiteRuntime SDK path. */
export async function deriveDropPasswordVerifier(password: string, saltB64: string): Promise<string> {
  return toB64(await deriveShareKey(password, fromB64(saltB64)));
}

function defaultStorage(): DropStorage {
  try {
    if (typeof localStorage !== "undefined" && localStorage) {
      localStorage.getItem("mh_drop_probe"); // throws in some sandboxed contexts
      return {
        get: (k) => localStorage.getItem(k),
        set: (k, v) => localStorage.setItem(k, v),
      };
    }
  } catch {
    /* fall through */
  }
  const mem = new Map<string, string>();
  return { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) };
}

function mapStatus(status: number): MhErrorCode {
  if (status === 401) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 413) return "invalid_input";
  return "network";
}

/** Fetch + validate mh-drop.json and build a drop client. `configUrl` defaults
 *  to the page-relative "mh-drop.json", so the same page works under every
 *  mount (/sites/<name>/, /share/<slug>/). */
export async function initDrop(
  configUrl = "mh-drop.json",
  opts: DropClientOptions = {},
): Promise<DropClient> {
  const f = opts.fetcher ?? fetch;
  const res = await f(configUrl);
  if (!res.ok) throw new MhError("not_found", `no drop config at ${configUrl}`);
  const cfg = (await res.json().catch(() => null)) as DropConfig | null;
  if (!cfg || cfg.v !== 1 || !cfg.endpoint || !cfg.drop_id || !cfg.key_id || !cfg.pk)
    throw new MhError("invalid_input", "malformed mh-drop.json");
  // Seed the clock offset from this response's Date header BEFORE the first send.
  // Otherwise a device whose wall clock is >5min fast seals its FIRST envelope
  // with offset 0, the owner's ingest clamp rejects it, and the visitor is left
  // with a permanent optimistic "_pending" that never lands (later sends learn
  // the offset from the POST server_time — only the first was unprotected).
  seedClockOffset(cfg, res.headers.get("date"), opts);
  return createDrop(cfg, opts);
}

/** Prime the persisted clock offset from a server Date header, unless a more
 *  precise offset (learned from a real POST server_time) is already stored. */
function seedClockOffset(cfg: DropConfig, dateHeader: string | null, opts: DropClientOptions): void {
  if (!dateHeader) return;
  const serverMs = Date.parse(dateHeader);
  if (!Number.isFinite(serverMs)) return;
  const store = opts.storage ?? defaultStorage();
  const key = "mh_drop_clock:" + cfg.endpoint.replace(/\/+$/, "");
  if (store.get(key)) return; // keep an already-learned, more precise offset
  const nowFn = opts.now ?? (() => Date.now());
  store.set(key, String(serverMs - nowFn()));
}

export interface DropClient {
  config: DropConfig;
  guest: string;
  createRecord(
    dbRef: string,
    values: Record<string, unknown>,
    callOpts?: { turnstileToken?: string },
  ): Promise<PendingRecord>;
  pending(dbRef?: string): PendingRecord[];
  merge<T extends { id: string }>(serverRows: T[], dbRef?: string): (T | PendingRecord)[];
}

export function createDrop(cfg: DropConfig, opts: DropClientOptions = {}): DropClient {
  const store = opts.storage ?? defaultStorage();
  const f = opts.fetcher ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const endpoint = cfg.endpoint.replace(/\/+$/, "");

  // ---- guest identity: one per visitor, persistent -------------------------------
  const GUEST_KEY = "mh_drop_guest";
  let guest = store.get(GUEST_KEY);
  if (!guest || !GUEST_NODE_RE.test(guest)) {
    guest = newGuestNode();
    store.set(GUEST_KEY, guest);
  }

  // ---- mini-HLC: parseHlc-compatible `<millis:15>-<counter:hex4>-<guest>` ---------
  // Clock offset learned from the host's server_time on each accepted POST keeps
  // the visitor comfortably inside the owner's +5min ingest clamp even on a
  // badly skewed device.
  const CLOCK_KEY = "mh_drop_clock:" + endpoint;
  let offset = Number(store.get(CLOCK_KEY) ?? "0") || 0;
  const HLC_KEY = "mh_drop_hlc:" + guest;
  const storedHlc = /^(\d+):(\d+)$/.exec(store.get(HLC_KEY) ?? "");
  let last = storedHlc
    ? { millis: Number(storedHlc[1]), counter: Number(storedHlc[2]) }
    : { millis: 0, counter: 0 };

  function nextHlc(): string {
    const wall = now() + offset;
    const millis = Math.max(last.millis, wall);
    const counter = millis === last.millis ? last.counter + 1 : 0;
    last = { millis, counter };
    store.set(HLC_KEY, `${millis}:${counter}`);
    return `${String(millis).padStart(15, "0")}-${counter.toString(16).padStart(4, "0")}-${guest}`;
  }

  // ---- pending (optimistic echo) store --------------------------------------------
  const PEND_KEY = "mh_drop_pending:" + cfg.drop_id;
  function readPending(): PendingRecord[] {
    try {
      const raw = store.get(PEND_KEY);
      const rows = raw ? (JSON.parse(raw) as PendingRecord[]) : [];
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }
  function writePending(rows: PendingRecord[]): void {
    store.set(PEND_KEY, JSON.stringify(rows));
  }

  // ---- schema lookup ---------------------------------------------------------------
  function resolveDb(ref: string): DropDatabaseInfo {
    const dbs = cfg.databases ?? [];
    const hit =
      dbs.find((d) => d.id === ref) ?? dbs.find((d) => d.name.toLowerCase() === ref.toLowerCase());
    if (!hit) throw new MhError("not_found", `"${ref}" is not a submittable table on this page`);
    return hit;
  }
  function resolveProp(dbInfo: DropDatabaseInfo, key: string): DropPropertyInfo {
    const hit =
      dbInfo.properties.find((p) => p.id === key) ??
      dbInfo.properties.find((p) => p.name.toLowerCase() === key.toLowerCase());
    if (!hit) throw new MhError("not_found", `unknown column: ${key}`);
    return hit;
  }

  // ---- password verifier (derived once, lazily) --------------------------------------
  let verifierPromise: Promise<string | null> | null = null;
  function verifier(): Promise<string | null> {
    verifierPromise ??= (async () => {
      if (!opts.password || !cfg.password_salt) return null;
      return deriveDropPasswordVerifier(opts.password, cfg.password_salt);
    })();
    return verifierPromise;
  }

  async function createRecord(
    dbRef: string,
    values: Record<string, unknown>,
    callOpts: { turnstileToken?: string } = {},
  ): Promise<PendingRecord> {
    const dbInfo = resolveDb(dbRef);
    const rowId = "rec_" + randomSuffix(10);
    // Resolve the cells once (id-keyed for the wire, name-keyed for the echo).
    const cells: Record<string, unknown> = {};
    const byName: Record<string, unknown> = {};
    const idKeyed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      const prop = resolveProp(dbInfo, key);
      cells[prop.id] = value;
      byName[prop.name] = value;
      idKeyed[prop.id] = value ?? null;
    }

    // v2 (when the owner accepts it): a high-level GuestIntent — the browser
    // mints NO HLC/ops; the owner does, on the guest's own timeline. Idempotent
    // on intentId. v1 (default during the transition): pre-signed ops under the
    // visitor's mini-HLC (kept until the owner flips payload_versions to include 2).
    const acceptsV2 = (cfg.payload_versions ?? [1]).includes(2);
    let payload: AnyDropPayload;
    if (acceptsV2) {
      const intent: GuestIntent = {
        intentId: "int_" + randomSuffix(16),
        action: "createRecord",
        table: dbInfo.id,
        recordId: rowId,
        payload: idKeyed,
        submittedAt: now() + offset, // offset-corrected → inside the owner's clamp
      };
      payload = { v: 2, guest_node: guest!, intents: [intent] };
    } else {
      const changes: Change[] = [];
      const push = (col: string, value: unknown, hlc: string): void => {
        changes.push({
          hlc,
          node_id: guest!,
          dataset: "records",
          row_id: rowId,
          col,
          value: value === undefined || value === null ? null : JSON.stringify(value),
        });
      };
      const firstHlc = nextHlc();
      push("database_id", dbInfo.id, firstHlc);
      push("created_hlc", firstHlc, nextHlc());
      for (const [id, value] of Object.entries(idKeyed)) push(id, value, nextHlc());
      payload = { v: 1, guest_node: guest!, changes };
    }
    const envelope = await sealDropEnvelope({
      dropId: cfg.drop_id,
      keyId: cfg.key_id,
      pk: fromB64(cfg.pk),
      payload,
      now: now(),
    });

    const headers: Record<string, string> = { "content-type": "application/json" };
    const pass = await verifier();
    if (pass) headers["x-drop-pass"] = pass;
    if (callOpts.turnstileToken) headers["x-turnstile-token"] = callOpts.turnstileToken;

    let res: Response;
    try {
      res = await f(`${endpoint}/v1/inbox/${encodeURIComponent(cfg.drop_id)}/envelopes`, {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
      });
    } catch (e) {
      throw new MhError("network", `drop submission failed: ${(e as Error).message}`);
    }
    const data = (await res.json().catch(() => null)) as
      | { error?: string; server_time?: number }
      | null;
    if (!res.ok)
      throw new MhError(mapStatus(res.status), data?.error ?? `drop submission failed (HTTP ${res.status})`);
    if (typeof data?.server_time === "number") {
      offset = data.server_time - now();
      store.set(CLOCK_KEY, String(offset));
    }

    const rec: PendingRecord = {
      id: rowId,
      database_id: dbInfo.id,
      values: byName,
      cells,
      _pending: true,
      envelope_id: envelope.envelope_id,
      created_at: now(),
    };
    writePending([...readPending(), rec]);
    return rec;
  }

  function pending(dbRef?: string): PendingRecord[] {
    const rows = readPending();
    if (!dbRef) return rows;
    const dbId = resolveDb(dbRef).id;
    return rows.filter((r) => r.database_id === dbId);
  }

  /** Reconcile server rows with locally-pending echoes: a pending id that now
   *  appears server-side has landed (ingested + republished) → drop the echo;
   *  the rest ride along tagged `_pending`. */
  function merge<T extends { id: string }>(serverRows: T[], dbRef?: string): (T | PendingRecord)[] {
    const seen = new Set(serverRows.map((r) => r.id));
    const all = readPending();
    const remaining = all.filter((p) => !seen.has(p.id));
    if (remaining.length !== all.length) writePending(remaining);
    const dbId = dbRef ? resolveDb(dbRef).id : null;
    const extras = remaining.filter((p) => dbId === null || p.database_id === dbId);
    return [...serverRows, ...extras];
  }

  return { config: cfg, guest: guest!, createRecord, pending, merge };
}
