import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { getNodeId } from "../../core/node.ts";
import { getServerConfig, setServerConfig, type ServerConfig } from "../../core/config.ts";
import { parseDuration } from "../../core/sync/token.ts";
import {
  generatePairingCode,
  performPairing,
  listGrants,
  revokeGrant,
} from "../../core/sync/pairing.ts";
import {
  listPeers,
  removePeer,
  setPeerEnabled,
  syncPeer,
  syncAllPeers,
  type PeerRow,
} from "../../core/sync/peers.ts";
import { print, table, guard } from "../output.ts";

// Single command, positional dispatch (no citty subCommands — a parent `run`
// would double-execute alongside a matched subcommand; see token.ts). Supports
// both an interactive wizard (`mh config`, no args, on a TTY) and direct flags
// (`mh config --port 7777`, `mh config peer add --url ... --code ...`).

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : "");
const isTTY = () => process.stdout.isTTY && process.stdin.isTTY;

/** Bun global prompt(); returns trimmed input, or `def` when the user hits Enter. */
function ask(label: string, def?: string): string {
  const suffix = def != null && def !== "" ? ` [${def}]` : "";
  const raw = globalThis.prompt(`${label}${suffix}:`);
  const val = (raw ?? "").trim();
  return val === "" && def != null ? def : val;
}

/** A flag value, or an interactive prompt fallback on a TTY, else an error. */
function flagOrAsk(flag: unknown, label: string): string {
  if (typeof flag === "string" && flag !== "") return flag;
  if (isTTY()) {
    const v = ask(label);
    if (v) return v;
  }
  throw new Error(`missing --${label}`);
}

function showConfig(db: ReturnType<typeof openMetahub>): void {
  const cfg = getServerConfig(db);
  const peers = listPeers(db).map(peerView);
  print({ config: cfg, peers }, () => {
    const lines = [
      "server config:",
      `  host:          ${cfg.host}`,
      `  port:          ${cfg.port}`,
      `  sync-interval: ${Math.round(cfg.syncIntervalMs / 1000)}s`,
      `  auto-sync:     ${cfg.autoSync}`,
      "",
      "peers:",
      peers.length ? table(peers) : "  (none)",
    ];
    return lines.join("\n");
  });
}

function peerView(p: PeerRow) {
  return {
    url: p.url,
    label: p.label ?? "",
    enabled: p.enabled ? "yes" : "no",
    status: p.last_status ?? "",
    last_sync: iso(p.last_sync_at),
  };
}

function applySet(db: ReturnType<typeof openMetahub>, args: Record<string, any>): void {
  const partial: Partial<ServerConfig> = {};
  if (typeof args.host === "string" && args.host !== "") partial.host = args.host;
  if (args.port != null && args.port !== "") partial.port = Number(args.port);
  if (args["sync-interval"] != null && args["sync-interval"] !== "")
    partial.syncIntervalMs = parseDuration(String(args["sync-interval"]), 30_000);
  if (args["auto-sync"] != null) partial.autoSync = parseBool(args["auto-sync"]);
  const next = setServerConfig(db, partial);
  print(next, () => `updated. (restart --server to apply host/port/interval changes)`);
}

function parseBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

async function peerDispatch(
  db: ReturnType<typeof openMetahub>,
  action: string,
  args: Record<string, any>,
): Promise<void> {
  const node = getNodeId(db);
  switch (action) {
    case "add": {
      const url = flagOrAsk(args.url, "url");
      const code = flagOrAsk(args.code, "code");
      const selfUrl = typeof args["self-url"] === "string" ? args["self-url"] : undefined;
      const r = await performPairing(db, node, url, code, selfUrl);
      const sync = await syncPeer(db, url);
      print({ paired: r, sync }, () => `paired with ${r.url} (node ${r.node_id}); ${syncLine(sync)}`);
      return;
    }
    case "code": {
      const c = generatePairingCode(db);
      print(c, () => `pairing code: ${c.code}\nexpires:      ${iso(c.exp)}\n(redeem with: mh config peer add --url <this-server-url> --code ${c.code})`);
      return;
    }
    case "list":
      print(listPeers(db).map(peerView), (() => {
        const rows = listPeers(db).map(peerView);
        return rows.length ? table(rows) : "(no peers)";
      }));
      return;
    case "rm": {
      const url = flagOrAsk(args.url, "url");
      print({ ok: removePeer(db, url) }, () => `removed ${url}`);
      return;
    }
    case "enable":
    case "disable": {
      const url = flagOrAsk(args.url, "url");
      setPeerEnabled(db, url, action === "enable");
      print({ ok: true }, () => `${action}d ${url}`);
      return;
    }
    case "sync": {
      if (typeof args.url === "string" && args.url !== "") {
        const r = await syncPeer(db, args.url);
        print(r, () => syncLine(r));
      } else {
        const r = await syncAllPeers(db);
        print(r, () => (r.length ? r.map(syncLine).join("\n") : "(no enabled peers)"));
      }
      return;
    }
    default:
      throw new Error(`unknown peer action '${action}' (add|code|list|rm|enable|disable|sync)`);
  }
}

function syncLine(o: { url: string; ok: boolean; pushed?: number; pulled?: number; error?: string }) {
  return o.ok ? `${o.url}: pushed ${o.pushed}, pulled ${o.pulled}` : `${o.url}: error — ${o.error}`;
}

const maskToken = (t: string) => (t.length > 10 ? `${t.slice(0, 8)}…` : t);

function grantView(g: { token: string; peer_url: string | null; node_id: string | null; created_at: number | null }) {
  return {
    token: maskToken(g.token),
    peer_url: g.peer_url ?? "(unknown)",
    node_id: g.node_id ?? "",
    issued: iso(g.created_at),
  };
}

function grantDispatch(
  db: ReturnType<typeof openMetahub>,
  action: string,
  args: Record<string, any>,
): void {
  switch (action) {
    case "list": {
      const rows = listGrants(db).map(grantView);
      print(rows, () => (rows.length ? table(rows) : "(no issued credentials)"));
      return;
    }
    case "revoke": {
      const token = flagOrAsk(args.token, "token");
      const n = revokeGrant(db, token);
      print({ revoked: n }, () => (n > 0 ? `revoked ${n} credential(s)` : "no matching credential"));
      return;
    }
    default:
      throw new Error(`unknown grant action '${action}' (list|revoke)`);
  }
}

// --- interactive wizard -----------------------------------------------------

function serverWizard(db: ReturnType<typeof openMetahub>): void {
  const cur = getServerConfig(db);
  const host = ask("Host", cur.host);
  const port = Number(ask("Port", String(cur.port)));
  const interval = parseDuration(ask("Sync interval", `${Math.round(cur.syncIntervalMs / 1000)}s`), cur.syncIntervalMs);
  const autoSync = parseBool(ask("Auto-sync (true/false)", String(cur.autoSync)));
  setServerConfig(db, { host, port, syncIntervalMs: interval, autoSync });
  console.log("✓ saved (restart --server to apply host/port/interval)");
}

async function peerWizard(db: ReturnType<typeof openMetahub>): Promise<void> {
  const node = getNodeId(db);
  for (;;) {
    console.log("\n同步设备:");
    console.log("  1) 添加设备 (输入对方地址 + 配对码)");
    console.log("  2) 生成本机配对码");
    console.log("  3) 列出设备");
    console.log("  4) 移除设备");
    console.log("  5) 启用/禁用设备");
    console.log("  6) 立即同步全部");
    console.log("  7) 已签发凭据 (列出/吊销)");
    console.log("  8) 返回");
    const c = ask("选择 (1-8)");
    if (c === "" || c === "8") return;
    try {
      if (c === "1") {
        const url = ask("对方服务器地址 (如 http://192.168.1.10:7777)");
        const code = ask("配对码");
        const selfUrl = ask("本机可达地址 (可选, 留空则单向)");
        if (!url || !code) {
          console.log("地址与配对码必填");
          continue;
        }
        const r = await performPairing(db, node, url, code, selfUrl || undefined);
        const sync = await syncPeer(db, url);
        console.log(`✓ 已配对 ${r.url} (node ${r.node_id}); ${syncLine(sync)}`);
      } else if (c === "2") {
        const code = generatePairingCode(db);
        console.log(`配对码: ${code.code}  (有效至 ${iso(code.exp)})`);
      } else if (c === "3") {
        const rows = listPeers(db).map(peerView);
        console.log(rows.length ? table(rows) : "(无设备)");
      } else if (c === "4") {
        const url = ask("要移除的地址");
        if (url) console.log(removePeer(db, url) ? `✓ 已移除 ${url}` : "未找到该设备");
      } else if (c === "5") {
        const url = ask("地址");
        const en = parseBool(ask("启用? (true/false)", "true"));
        if (url) {
          setPeerEnabled(db, url, en);
          console.log(`✓ ${en ? "已启用" : "已禁用"} ${url}`);
        }
      } else if (c === "6") {
        const r = await syncAllPeers(db);
        console.log(r.length ? r.map(syncLine).join("\n") : "(无启用的设备)");
      } else if (c === "7") {
        const rows = listGrants(db);
        console.log(rows.length ? table(rows.map(grantView)) : "(无已签发凭据)");
        if (rows.length) {
          const t = ask("输入要吊销的 token (或前缀, 留空跳过)");
          if (t) console.log(`✓ 已吊销 ${revokeGrant(db, t)} 条`);
        }
      }
    } catch (e) {
      console.log(`✗ ${(e as Error).message}`);
    }
  }
}

async function wizard(db: ReturnType<typeof openMetahub>): Promise<void> {
  for (;;) {
    console.log("\nMetahub 配置:");
    console.log("  1) 服务器设置");
    console.log("  2) 同步设备");
    console.log("  3) 退出");
    const c = ask("选择 (1-3)");
    if (c === "" || c === "3") return;
    if (c === "1") serverWizard(db);
    else if (c === "2") await peerWizard(db);
  }
}

export default defineCommand({
  meta: {
    name: "config",
    description:
      "Configure server + sync devices. Run with no args for an interactive wizard, or use flags directly (e.g. `config --port 7777`, `config peer add --url <url> --code <code>`).",
  },
  args: {
    section: { type: "positional", required: false, description: "show | set | peer | grant (omit for wizard)" },
    action: { type: "positional", required: false, description: "peer: add|code|list|rm|enable|disable|sync · grant: list|revoke" },
    host: { type: "string", description: "Bind address" },
    port: { type: "string", description: "Server port" },
    "sync-interval": { type: "string", description: "Auto-sync interval (e.g. 30s, 5m)" },
    "auto-sync": { type: "string", description: "Enable auto-sync timer (true/false)" },
    url: { type: "string", description: "Peer URL (peer add/rm/enable/disable/sync)" },
    code: { type: "string", description: "One-time pairing code (peer add)" },
    "self-url": { type: "string", description: "This device's reachable URL (peer add, optional)" },
    token: { type: "string", description: "Issued credential token or prefix (grant revoke)" },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const section = typeof args.section === "string" ? args.section : undefined;
    const hasSettingFlag =
      args.host != null ||
      args.port != null ||
      args["sync-interval"] != null ||
      args["auto-sync"] != null;

    if (!section) {
      if (hasSettingFlag) return applySet(db, args);
      if (isTTY()) return wizard(db);
      return showConfig(db); // non-interactive default
    }
    if (section === "show") return showConfig(db);
    if (section === "set") return applySet(db, args);
    if (section === "peer") return peerDispatch(db, (args.action as string) ?? "list", args);
    if (section === "grant") return grantDispatch(db, (args.action as string) ?? "list", args);
    throw new Error(`unknown config section '${section}' (show | set | peer | grant)`);
  }),
});
