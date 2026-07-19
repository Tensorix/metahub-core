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
import { policyForSite } from "../access-policy.ts";
import { putFileInline, deleteFile, type SiteRow } from "../sites-core.ts";
import { getEdgeConfig, getDropKnobs } from "./edge-config.ts";
import { httpDropHost, type DropHostApi } from "./drop-host.ts";
import { ensureDropKeys, activeDropKey } from "./drop-keys.ts";

/** Reserved site file the SDK auto-discovers. publishDirectory's --prune
 *  deliberately skips it (sites.ts) so a mirror re-publish can't sever the
 *  wiring between two grant commands. */
export const DROP_CONFIG_PATH = "mh-drop.json";

/** Reserved deployment manifest the SDK reads for EXPLICIT channel selection
 *  (mode + endpoints + policy revision) instead of guessing from 401/network.
 *  Published alongside mh-drop.json; --prune skips it too. */
export const MANIFEST_PATH = "mh-manifest.json";

/** The reserved files the grant/edge wiring owns — never pruned by a mirror
 *  publish (they'd be re-created immediately: pure delete/recreate oplog churn). */
export const RESERVED_SITE_FILES: ReadonlySet<string> = new Set([DROP_CONFIG_PATH, MANIFEST_PATH]);

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
    // Owner accepts v1 today; flips to [1, 2] once the v2 drop path is enabled,
    // at which point SDKs seal high-level intents instead of pre-signed ops.
    payload_versions: [1] as number[],
    ...(knobs?.turnstileSitekey ? { turnstile_sitekey: knobs.turnstileSitekey } : {}),
    ...(knobs?.passwordSalt ? { password_salt: knobs.passwordSalt } : {}),
    databases,
  };
}

type DropConfig = ReturnType<typeof buildDropConfig>;

/**
 * The deployment manifest: the SDK's explicit channel map. A create-granted,
 * edge-wired site is `mode:"live"` — the page's own origin serves the realtime
 * granted `/api/*` (relative runtimeEndpoint ""). Live success means the
 * SiteRuntime committed the write, so the generated manifest does NOT opt into
 * async fallback. The `drop` sub-block still embeds the public inbox config for
 * explicit/static-async deployments and operational discovery.
 */
function buildManifest(dropCfg: DropConfig, endpoint: string, policyRevision: number) {
  // Drop sub-block = the drop config's public fields (drop_id/key_id/pk/
  // turnstile_sitekey?/password_salt?/databases) minus the wire version + the
  // duplicate endpoint, plus the payload versions the owner accepts.
  const { v: _v, endpoint: _e, ...dropPublic } = dropCfg;
  return {
    v: 1 as const,
    mode: "live" as const,
    runtimeEndpoint: "", // relative: same origin as the page (the serving node)
    inboxEndpoint: endpoint,
    policyRevision,
    drop: { ...dropPublic, payload_versions: [1] as number[] }, // [1,2] once drop v2 is live
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
    // Deployment manifest alongside the drop config — the SDK's explicit channel
    // map. policyRevision fingerprints the client-observable policy so a public
    // grant/gate edit republishes a revision the SDK/publisher can see.
    const revision = policyForSite({ publicGrants: site.public_grants, knobs: getDropKnobs(db, site.id) }).revision;
    putFileInline(db, site.id, MANIFEST_PATH, {
      data: JSON.stringify(buildManifest(cfg, edge.endpoint, revision), null, 2),
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
  deleteFile(db, site.id, MANIFEST_PATH);
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
