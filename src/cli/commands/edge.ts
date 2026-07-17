// `mh edge` — operate the edge component itself (deploy/status/pull/rotate/
// connect). Everything ABOUT the write-inbox transport lives here; the user's
// semantic act ("this table is publicly writable") stays on `mh site grant`,
// which auto-wires mh-drop.json + the inbox registration (design.md §3.1).
//
// Service creation discipline: `mh edge deploy` deploys INTO a Worker and a D1
// database the user already created in their own Cloudflare account. A missing
// resource is a loud not_found — there is no --create and never will be.

import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { MhError } from "../../core/errors.ts";
import { randomSuffix } from "../../core/ids.ts";
import {
  getEdgeConfig,
  setEdgeConfig,
  type CfEdgeTarget,
  type EdgeConfig,
} from "../../core/sync/edge-config.ts";
import {
  workerExists,
  d1Exists,
  d1Exec,
  uploadEdgeWorker,
  putWorkerSecret,
  workersDevSubdomain,
} from "../../core/sync/cf-api.ts";
import { EDGE_WORKER_VERSION, EDGE_SCHEMA_SQL } from "../../workers/edge-worker.ts";
import { listPeers } from "../../core/sync/peers.ts";
import { ensureDropKeys, rotateDropKeys, activeDropKey } from "../../core/sync/drop-keys.ts";
import { httpDropHost } from "../../core/sync/drop-host.ts";
import { pullDropsOnce, dropWiredSites, type DropPullSummary } from "../../core/sync/drop-pull.ts";
import { syncDropWiring, type DropWireResult } from "../../core/sync/drop-wire.ts";
import { getEdgeWorkerScript } from "../edge-worker-script.ts";
import { print, table, guard, warn } from "../output.ts";

/** Re-run the grant↔inbox wiring for every create-granted site (after deploy /
 *  connect / rotate — the endpoint, registration set or public key changed). */
async function rewireAll(db: ReturnType<typeof openMetahub>): Promise<DropWireResult[]> {
  const out: DropWireResult[] = [];
  for (const site of dropWiredSites(db)) {
    const r = await syncDropWiring(db, site);
    if (r.registerError) warn(`site ${r.name}: inbox registration failed — ${r.registerError}`);
    out.push(r);
  }
  return out;
}

function wiredLine(wired: DropWireResult[]): string {
  if (wired.length === 0) return "";
  return (
    "\nwired sites: " +
    wired.map((w) => `${w.name} (mh-drop.json ${w.file}, registration ${w.registered ? "ok" : "FAILED"})`).join(", ")
  );
}

const TOKEN_NOTE =
  "note: Cloudflare API tokens are account-scoped (no per-Worker granularity exists); " +
  "mh only writes to the named Worker and D1 — a behavioral promise, auditable in this open-source code.";

const deploy = defineCommand({
  meta: {
    name: "deploy",
    description:
      "Deploy/upgrade the edge worker into YOUR Cloudflare Worker + D1 (resources must already exist; mh never creates them)",
  },
  args: {
    "account-id": { type: "string", description: "Cloudflare account id" },
    "api-token": { type: "string", description: "Cloudflare API token (Workers Scripts + D1 edit)" },
    worker: { type: "string", description: "Worker script name (created by you in the CF dashboard)" },
    d1: { type: "string", description: "D1 database UUID (created by you in the CF dashboard)" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const prev = getEdgeConfig(db);
    const usage = "mh edge deploy --account-id <id> --api-token <token> --worker <name> --d1 <uuid>";
    const pick = (flag: unknown, stored: string | undefined, label: string): string => {
      if (typeof flag === "string" && flag !== "") return flag;
      if (stored) return stored;
      throw new MhError("invalid_input", `missing --${label}\nusage: ${usage}`);
    };
    const cf: CfEdgeTarget = {
      accountId: pick(args["account-id"], prev?.cf?.accountId, "account-id"),
      apiToken: pick(args["api-token"], prev?.cf?.apiToken, "api-token"),
      workerName: pick(args.worker, prev?.cf?.workerName, "worker"),
      d1Id: pick(args.d1, prev?.cf?.d1Id, "d1"),
    };

    // Existence checks FIRST — mh deploys content into user-created resources,
    // it never creates them (no --create escape hatch, by design).
    if (!(await workerExists(cf)))
      throw new MhError(
        "not_found",
        `Worker "${cf.workerName}" does not exist on this Cloudflare account — create it in the Cloudflare dashboard first (mh never creates remote resources)`,
      );
    if (!(await d1Exists(cf)))
      throw new MhError(
        "not_found",
        `D1 database ${cf.d1Id} does not exist on this Cloudflare account — create it in the Cloudflare dashboard first (mh never creates remote resources)`,
      );

    await d1Exec(cf, EDGE_SCHEMA_SQL); // idempotent IF NOT EXISTS migration
    await uploadEdgeWorker(cf, await getEdgeWorkerScript());
    const token = prev?.token ?? "drt_" + randomSuffix(32);
    await putWorkerSecret(cf, "OWNER_TOKEN", token);
    const endpoint =
      prev?.endpoint ?? `https://${cf.workerName}.${await workersDevSubdomain(cf)}.workers.dev`;

    // The recipient keypair auto-provisions on first deploy (bucket-authoritative
    // when an encrypted bucket is attached; local otherwise).
    const keyring = await ensureDropKeys(db);
    const key = activeDropKey(keyring);

    const cfg: EdgeConfig = { endpoint, token, cf, deployedVersion: EDGE_WORKER_VERSION };
    setEdgeConfig(db, cfg);
    const wired = await rewireAll(db);

    print(
      {
        endpoint,
        worker: cf.workerName,
        d1: cf.d1Id,
        version: EDGE_WORKER_VERSION,
        key_id: key.key_id,
        wired,
      },
      () =>
        `deployed edge worker "${cf.workerName}" (version ${EDGE_WORKER_VERSION})\n` +
        `endpoint: ${endpoint}\n` +
        `inbox key: ${key.key_id}${wiredLine(wired)}\n` +
        TOKEN_NOTE,
    );
  }),
});

const status = defineCommand({
  meta: {
    name: "status",
    description: "Edge health: worker version alignment + per-site inbox backlog/quota",
  },
  args: {},
  run: guard(async () => {
    const db = openMetahub();
    const cfg = getEdgeConfig(db);
    if (!cfg)
      throw new MhError("not_found", "edge is not configured — run `mh edge deploy` (Cloudflare) or `mh edge connect` (other hosts)");
    const host = httpDropHost(cfg.endpoint, cfg.token);

    let workerVersion: string | null = null;
    let healthError: string | undefined;
    try {
      workerVersion = (await host.health()).version ?? null;
    } catch (e) {
      healthError = (e as Error).message;
    }
    const aligned = workerVersion === EDGE_WORKER_VERSION;

    const drops: {
      site: string;
      drop_id: string;
      envelopes?: number;
      bytes?: number;
      max_envelopes?: number;
      max_bytes?: number;
      error?: string;
    }[] = [];
    for (const site of dropWiredSites(db)) {
      try {
        const s = await host.stats(site.id);
        drops.push({
          site: site.name,
          drop_id: site.id,
          envelopes: s.envelopes,
          bytes: s.bytes,
          max_envelopes: s.max_envelopes,
          max_bytes: s.max_bytes,
        });
      } catch (e) {
        drops.push({ site: site.name, drop_id: site.id, error: (e as Error).message });
      }
    }

    // Room overview: every kind='room' peer (one per --room share), with its
    // local sync bookkeeping — the room itself is a data surface, not a
    // status API, so this reads what the owner side already tracks.
    const rooms = listPeers(db)
      .filter((p) => p.kind === "room" && p.config)
      .map((p) => {
        const rc = JSON.parse(p.config!) as { base?: string; slug?: string };
        return {
          slug: rc.slug ?? p.url,
          url: rc.base && rc.slug ? `${rc.base.replace(/\/+$/, "")}/r/${rc.slug}/` : p.url,
          last_status: p.last_status,
          last_success_at: p.last_success_at,
          last_error: p.last_error,
        };
      });

    print(
      {
        endpoint: cfg.endpoint,
        worker: {
          version: workerVersion,
          expected: EDGE_WORKER_VERSION,
          aligned,
          ...(healthError ? { error: healthError } : {}),
        },
        drops,
        rooms,
      },
      () => {
        const lines = [
          `endpoint: ${cfg.endpoint}`,
          healthError
            ? `worker:   UNREACHABLE — ${healthError}`
            : `worker:   version ${workerVersion}${aligned ? " (up to date)" : ` — expected ${EDGE_WORKER_VERSION}, run: mh edge deploy`}`,
        ];
        lines.push(
          drops.length
            ? "inboxes:\n" +
                table(
                  drops.map((d) => ({
                    site: d.site,
                    backlog: d.error ? "—" : `${d.envelopes}/${d.max_envelopes}`,
                    bytes: d.error ? "—" : `${d.bytes}/${d.max_bytes}`,
                    status: d.error ?? "ok",
                  })),
                )
            : "inboxes:  (no sites with a create grant)",
        );
        lines.push(
          rooms.length
            ? "rooms:\n" +
                table(
                  rooms.map((r) => ({
                    room: r.slug,
                    last_sync: r.last_success_at ? new Date(r.last_success_at).toISOString() : "never",
                    state: r.last_status ?? "—",
                    detail: r.last_error ?? "",
                  })),
                )
            : "rooms:    (none — create one with `mh share create <site> --grant … --room`)",
        );
        return lines.join("\n");
      },
    );
  }),
});

function pullLines(r: DropPullSummary): string {
  if (r.skipped === "no_edge") return "edge is not configured";
  if (r.skipped === "no_sites") return "no sites with a create grant — nothing to pull";
  if (r.skipped === "no_keys") return "no drop keys on this device — run `mh edge deploy` here or attach the workspace bucket";
  if (r.skipped === "not_publisher") return "another device holds the publisher lease — skipped (it pulls for the fleet)";
  const per = r.drops
    .map((d) => `  ${d.site}: fetched ${d.fetched}, ingested ${d.ingested} op(s), acked ${d.acked}, rejected ${d.rejected}, deferred ${d.deferred}`)
    .join("\n");
  return `pulled ${r.fetched} envelope(s) → ${r.ingested} new op(s), acked ${r.acked}, rejected ${r.rejected}, deferred ${r.deferred}` + (per ? `\n${per}` : "");
}

const pull = defineCommand({
  meta: { name: "pull", description: "Pull pending inbox submissions once (debug; auto-sync pulls every ~60s)" },
  args: {},
  run: guard(async () => {
    const db = openMetahub();
    if (!getEdgeConfig(db))
      throw new MhError("not_found", "edge is not configured — run `mh edge deploy` or `mh edge connect`");
    const r = await pullDropsOnce(db, { ignoreLease: true });
    print(r, () => pullLines(r));
  }),
});

const rotate = defineCommand({
  meta: {
    name: "rotate",
    description:
      "Rotate the inbox sealing keypair (old keys stay retired so in-flight envelopes still open; --purge-retired drops the previously-retired generation)",
  },
  args: {
    "purge-retired": { type: "boolean", description: "Also remove keys retired before this rotation" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const { keyring, active, purged } = await rotateDropKeys(db, {
      purgeRetired: Boolean(args["purge-retired"]),
    });
    // Republish mh-drop.json so pages seal to the NEW key immediately.
    const wired = getEdgeConfig(db) ? await rewireAll(db) : [];
    print(
      {
        active: active.key_id,
        keys: keyring.keys.length,
        retired: keyring.keys.filter((k) => k.retired).length,
        purged,
        wired,
      },
      () =>
        `rotated: new active key ${active.key_id} (${keyring.keys.length} key(s), ` +
        `${keyring.keys.filter((k) => k.retired).length} retired${purged.length ? `, purged ${purged.join(", ")}` : ""})` +
        wiredLine(wired) +
        "\nretired keys keep opening in-flight envelopes; purge them with --purge-retired once the backlog drains",
    );
  }),
});

const connect = defineCommand({
  meta: {
    name: "connect",
    description: "Use a non-Cloudflare inbox host (any endpoint speaking the /v1/inbox protocol)",
  },
  args: {
    endpoint: { type: "string", description: "Inbox host base URL" },
    token: { type: "string", description: "Owner secret the host expects (Bearer)" },
  },
  run: guard(async (args) => {
    const usage = "mh edge connect --endpoint <url> --token <t>";
    if (typeof args.endpoint !== "string" || !args.endpoint)
      throw new MhError("invalid_input", `missing --endpoint\nusage: ${usage}`);
    if (typeof args.token !== "string" || !args.token)
      throw new MhError("invalid_input", `missing --token\nusage: ${usage}`);
    const db = openMetahub();
    const endpoint = args.endpoint.replace(/\/+$/, "");
    const health = await httpDropHost(endpoint, args.token).health(); // loud fail-fast at the call site
    if (!health.ok) throw new MhError("network", `inbox host at ${endpoint} is not healthy`);
    const keyring = await ensureDropKeys(db);
    setEdgeConfig(db, { endpoint, token: args.token, deployedVersion: health.version });
    const wired = await rewireAll(db);
    print(
      { endpoint, version: health.version ?? null, key_id: activeDropKey(keyring).key_id, wired },
      () => `connected to inbox host ${endpoint}${health.version ? ` (version ${health.version})` : ""}${wiredLine(wired)}`,
    );
  }),
});

export default defineCommand({
  meta: {
    name: "edge",
    description:
      "Operate the edge write-inbox (async public submissions for sites with a create grant): deploy to your own Cloudflare Worker+D1, check status, pull, rotate keys",
  },
  subCommands: { deploy, status, pull, rotate, connect },
});
