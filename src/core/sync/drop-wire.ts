// Auto-wiring between site grants and the write-inbox: the inbox is a
// TRANSPORT, not a user concept (design.md §3.1 "信箱零暴露"). The user's only
// semantic act is `mh site grant <site> <db>:create`; when the edge is
// configured, publish/grant call syncDropWiring, which
//   - publishes/updates the site file `mh-drop.json` (public key + endpoint +
//     the offline schema a page needs to author pre-signed ops), and
//   - registers the drop with the inbox host (PUT, carrying the anti-abuse
//     knobs — Turnstile secret / password verifier);
// and when the last create grant goes away (revoke/--clear), removes the file
// and deletes the registration. The SDK auto-discovers mh-drop.json and routes
// createRecord through the sealed transport when the realtime endpoint is
// unavailable — site authors keep writing plain `api.createRecord(...)`.

import type { DbDriver } from "../driver.ts";
import { getDatabase } from "../databases.ts";
import { listProperties } from "../properties.ts";
import { parseGrantSet, GUEST_COERCIBLE_TYPES } from "../grants-core.ts";
import { putFileInline, deleteFile, type SiteRow } from "../sites-core.ts";
import { getEdgeConfig, getDropKnobs } from "./edge-config.ts";
import { httpDropHost, type DropHostApi } from "./drop-host.ts";
import { ensureDropKeys, activeDropKey } from "./drop-keys.ts";

/** Reserved site file the SDK auto-discovers. publishDirectory's --prune
 *  deliberately skips it (sites.ts) so a mirror re-publish can't sever the
 *  wiring between two grant commands. */
export const DROP_CONFIG_PATH = "mh-drop.json";

export interface DropWireResult {
  site: string;
  name: string;
  /** create grant present AND edge configured — the drop transport is live. */
  wired: boolean;
  /** What happened to mh-drop.json. */
  file: "written" | "unchanged" | "removed" | "none";
  /** Host registration outcome; null when none was attempted. */
  registered: boolean | null;
  registerError?: string;
  /** Which transport create-grant submissions ride (null: no create grant). */
  transport: "edge" | "server" | null;
}

export function siteHasCreateGrant(site: Pick<SiteRow, "public_grants">): boolean {
  return parseGrantSet(site.public_grants).tables.some((t) => t.ops.includes("create"));
}

/** The published drop config: everything an anonymous page needs to seal a
 *  valid submission OFFLINE from the realtime endpoint — including the
 *  create-granted tables' schema (property ids/types), since pre-signed ops
 *  address property IDs, not names. Only guest-writable property types are
 *  listed (anything else would be refused at ingest anyway). */
function buildDropConfig(db: DbDriver, site: SiteRow, endpoint: string, key: { key_id: string; pk: string }) {
  const set = parseGrantSet(site.public_grants);
  const knobs = getDropKnobs(db, site.id);
  const databases = set.tables
    .filter((t) => t.ops.includes("create"))
    .map((t) => {
      const d = getDatabase(db, t.db);
      if (!d) return null;
      return {
        id: d.id,
        name: d.name,
        properties: listProperties(db, d.id)
          .filter((p) => GUEST_COERCIBLE_TYPES.has(p.type))
          .map((p) => ({ id: p.id, name: p.name, type: p.type })),
      };
    })
    .filter((d) => d !== null);
  return {
    v: 1,
    endpoint,
    drop_id: site.id,
    key_id: key.key_id,
    pk: key.pk,
    ...(knobs?.turnstileSitekey ? { turnstile_sitekey: knobs.turnstileSitekey } : {}),
    ...(knobs?.passwordSalt ? { password_salt: knobs.passwordSalt } : {}),
    databases,
  };
}

/**
 * Reconcile one site's drop wiring with its grants + the edge config. File
 * writes are idempotent (writeFileRow skip-unchanged: zero oplog rows when
 * nothing changed); host registration is re-PUT every time (idempotent upsert)
 * and failures are reported, not thrown — a temporarily unreachable edge must
 * not fail the grant/publish command that triggered the wiring.
 */
export async function syncDropWiring(
  db: DbDriver,
  site: SiteRow,
  opts: { host?: DropHostApi } = {},
): Promise<DropWireResult> {
  const edge = getEdgeConfig(db);
  const hasCreate = siteHasCreateGrant(site);

  if (hasCreate && edge) {
    const keyring = await ensureDropKeys(db);
    const key = activeDropKey(keyring);
    const cfg = buildDropConfig(db, site, edge.endpoint, key);
    const f = putFileInline(db, site.id, DROP_CONFIG_PATH, {
      data: JSON.stringify(cfg, null, 2),
      contentType: "application/json",
    });
    const knobs = getDropKnobs(db, site.id);
    const host = opts.host ?? httpDropHost(edge.endpoint, edge.token);
    let registered = true;
    let registerError: string | undefined;
    try {
      await host.register(site.id, {
        turnstile_sitekey: knobs?.turnstileSitekey ?? null,
        turnstile_secret: knobs?.turnstileSecret ?? null,
        password_salt: knobs?.passwordSalt ?? null,
        password_verifier: knobs?.passwordVerifier ?? null,
      });
    } catch (e) {
      registered = false;
      registerError = (e as Error).message;
    }
    return {
      site: site.id,
      name: site.name,
      wired: true,
      file: f.changed ? "written" : "unchanged",
      registered,
      ...(registerError ? { registerError } : {}),
      transport: "edge",
    };
  }

  // Not wired (no create grant, or no edge): tear down any previous wiring.
  const removed = deleteFile(db, site.id, DROP_CONFIG_PATH);
  let registered: boolean | null = null;
  let registerError: string | undefined;
  if (removed && edge) {
    const host = opts.host ?? httpDropHost(edge.endpoint, edge.token);
    try {
      await host.unregister(site.id);
      registered = false;
    } catch (e) {
      registerError = (e as Error).message;
    }
  }
  return {
    site: site.id,
    name: site.name,
    wired: false,
    file: removed ? "removed" : "none",
    registered,
    ...(registerError ? { registerError } : {}),
    transport: hasCreate ? "server" : null,
  };
}
