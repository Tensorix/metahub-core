// `mh edge` — operate the edge component itself (deploy/status/pull/rotate/
// connect). Everything ABOUT the write-inbox transport lives here; the user's
// semantic act ("this table is publicly writable") stays on `mh site grant`,
// which auto-wires mh-drop.json + the inbox registration (design.md §3.1).
//
// `mh edge deploy` shares the same resumable Worker + D1 creation pipeline as
// the WebUI. Remote resources are never auto-deleted.

import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { MhError } from "../../core/errors.ts";
import { getEdgeConfig } from "../../core/sync/edge-config.ts";
import { EDGE_WORKER_VERSION } from "../../workers/edge-worker.ts";
import { listPeers } from "../../core/sync/peers.ts";
import { ensureDropKeys, rotateDropKeys, activeDropKey } from "../../core/sync/drop-keys.ts";
import { httpDropHost } from "../../core/sync/drop-host.ts";
import { pullDropsOnce, dropWiredSites, type DropPullSummary } from "../../core/sync/drop-pull.ts";
import { syncDropWiring, type DropWireResult } from "../../core/sync/drop-wire.ts";
import { connectInboxHost, deployEdge } from "../../core/sync/edge-service.ts";
import { roomUrlOf } from "../../core/sync/room-url.ts";
import { getEdgeWorkerScript } from "../edge-worker-script.ts";
import {
  cfOAuthConfigured,
  startCfLogin,
  openBrowser,
  discoverAccounts,
} from "../../core/sync/cf-oauth.ts";
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
  "mh only creates or updates the confirmed Worker, D1 and workers.dev resources; the token is never saved.";

const deploy = defineCommand({
  meta: {
    name: "deploy",
    description:
      "Create or safely continue a dedicated Cloudflare Worker + D1 Edge deployment",
  },
  args: {
    "account-id": { type: "string", description: "Cloudflare account id" },
    "api-token": { type: "string", description: "Cloudflare API token (Workers Scripts + D1 edit)" },
    worker: { type: "string", description: "Worker script name (defaults from this node id)" },
    d1: { type: "string", description: "D1 database name (defaults from this node id)" },
    subdomain: { type: "string", description: "workers.dev account subdomain if one must be created" },
    yes: { type: "boolean", description: "Confirm Cloudflare resource creation/update" },
  },
  run: guard((args) => runEdgeDeploy(args)),
});

/** Shared body of `mh edge deploy` and `mh config edge deploy` (the config
 *  namespace) — one implementation, two entry points. */
export async function runEdgeDeploy(args: Record<string, any>): Promise<void> {
    const db = openMetahub();
    const prev = getEdgeConfig(db);
    const flagAccount =
      typeof args["account-id"] === "string" && args["account-id"]
        ? args["account-id"]
        : prev?.cf?.accountId;
    const flagToken =
      typeof args["api-token"] === "string" && args["api-token"] ? args["api-token"] : null;

    // Credential resolution: an explicit --api-token stays the headless/CI path;
    // otherwise "Sign in with Cloudflare" (OAuth PKCE) opens the browser and
    // discovers the account, so no token or account id need be pasted.
    let accountId: string | undefined;
    let apiToken: string;
    if (flagToken) {
      if (!flagAccount)
        throw new MhError(
          "invalid_input",
          "missing --account-id\nusage: mh edge deploy --account-id <id> --api-token <token> --yes",
        );
      accountId = flagAccount;
      apiToken = flagToken;
    } else if (cfOAuthConfigured()) {
      const login = await startCfLogin();
      print(
        { authUrl: login.authUrl },
        () => `opening Cloudflare to authorize…\nif the browser didn't open, visit:\n${login.authUrl}`,
      );
      openBrowser(login.authUrl);
      const token = await login.waitForToken();
      apiToken = token.accessToken;
      accountId = flagAccount;
      if (!accountId) {
        const accounts = await discoverAccounts(token.accessToken);
        if (accounts.length === 0)
          throw new MhError("invalid_input", "该 Cloudflare 登录下没有可用账号");
        if (accounts.length > 1 && !flagAccount)
          throw new MhError(
            "invalid_input",
            "该登录关联多个 Cloudflare 账号，请用 --account-id 指定其一：\n" +
              accounts.map((a) => `  ${a.id}  ${a.name}`).join("\n"),
          );
        accountId = accounts[0]!.id;
      }
    } else {
      throw new MhError(
        "invalid_input",
        "未配置 Cloudflare OAuth，请用 --account-id <id> --api-token <token> 部署",
      );
    }

    if (!accountId) throw new MhError("invalid_input", "无法确定 Cloudflare 账号 id");
    const result = await deployEdge(
      db,
      {
        accountId,
        apiToken,
        workerName:
          typeof args.worker === "string" && args.worker ? args.worker : prev?.cf?.workerName,
        d1Name:
          typeof args.d1 === "string" && args.d1 ? args.d1 : prev?.cf?.d1Name,
        workersSubdomain:
          typeof args.subdomain === "string" && args.subdomain
            ? args.subdomain
            : prev?.cf?.workersSubdomain,
        confirmed: Boolean(args.yes),
      },
      await getEdgeWorkerScript(),
    );

    print(
      {
        status: result.status,
        endpoint: result.endpoint,
        worker: result.workerName,
        d1: { id: result.d1Id, name: result.d1Name },
        version: result.version,
        key_id: result.keyId,
        wired: result.wired,
        warnings: result.warnings,
      },
      () =>
        `deployed edge worker "${result.workerName}" (version ${result.version})\n` +
        `endpoint: ${result.endpoint}\n` +
        `D1: ${result.d1Name} (${result.d1Id})\n` +
        `inbox key: ${result.keyId}` +
        (result.wired.length
          ? `\nwired sites: ${result.wired.map((w) => `${w.site} (${w.registered ? "ok" : w.error ?? "FAILED"})`).join(", ")}`
          : "") +
        (result.warnings.length ? `\nwarnings: ${result.warnings.join("; ")}` : "") +
        "\n" +
        TOKEN_NOTE,
    );
}

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
          url: rc.base && rc.slug ? roomUrlOf({ base: rc.base, slug: rc.slug }) : p.url,
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
  const heldTail = (n: number) => (n ? `, held ${n}` : "");
  const per = r.drops
    .map((d) => `  ${d.site}: fetched ${d.fetched}, ingested ${d.ingested} op(s), acked ${d.acked}, rejected ${d.rejected}, deferred ${d.deferred}${heldTail(d.held)}`)
    .join("\n");
  const heldNote = r.held
    ? `\n${r.held} envelope(s) held — a local drop-key/bucket fault (mail kept, not deleted); fix the key and pull again`
    : "";
  return `pulled ${r.fetched} envelope(s) → ${r.ingested} new op(s), acked ${r.acked}, rejected ${r.rejected}, deferred ${r.deferred}${heldTail(r.held)}` + (per ? `\n${per}` : "") + heldNote;
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
  run: guard((args) => runEdgeRotateKeys(args)),
});

/** Shared body of `mh edge rotate` and `mh config edge rotate-keys`. */
export async function runEdgeRotateKeys(args: Record<string, any>): Promise<void> {
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
}

const connect = defineCommand({
  meta: {
    name: "connect",
    description: "Use a non-Cloudflare inbox host (any endpoint speaking the /v1/inbox protocol)",
  },
  args: {
    endpoint: { type: "string", description: "Inbox host base URL" },
    token: { type: "string", description: "Owner secret the host expects (Bearer)" },
  },
  run: guard((args) => runEdgeConnect(args)),
});

/** Shared body of `mh edge connect` and `mh config edge connect`. */
export async function runEdgeConnect(args: Record<string, any>): Promise<void> {
    const usage = "mh edge connect --endpoint <url> --token <t>";
    if (typeof args.endpoint !== "string" || !args.endpoint)
      throw new MhError("invalid_input", `missing --endpoint\nusage: ${usage}`);
    if (typeof args.token !== "string" || !args.token)
      throw new MhError("invalid_input", `missing --token\nusage: ${usage}`);
    const db = openMetahub();
    const status = await connectInboxHost(db, args.endpoint, args.token);
    const keyring = await ensureDropKeys(db);
    print(
      {
        status: status.status,
        endpoint: status.endpoint,
        version: status.version ?? null,
        key_id: activeDropKey(keyring).key_id,
        wired: status.wired ?? [],
        warnings: status.warnings,
      },
      () =>
        `connected to Edge ${status.endpoint} (version ${status.version ?? "unknown"})` +
        ((status.wired?.length ?? 0) > 0
          ? "\nwired sites: " +
            status.wired!
              .map((x) => `${x.site} (registration ${x.registered ? "ok" : `FAILED: ${x.error ?? "unknown"}`})`)
              .join(", ")
          : ""),
    );
}

export default defineCommand({
  meta: {
    name: "edge",
    description:
      "Operate the edge write-inbox (async public submissions for sites with a create grant): deploy to your own Cloudflare Worker+D1, check status, pull, rotate keys",
  },
  subCommands: { deploy, status, pull, rotate, connect },
});
