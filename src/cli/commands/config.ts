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
  type GrantRow,
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
import * as p from "@clack/prompts";

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

// --- interactive wizard (@clack/prompts) ------------------------------------
// Arrow-key driven: ↑↓ to move, Enter to pick, Esc/Ctrl-C to cancel. Only the
// no-arg TTY path reaches here (see run()); flag-driven dispatch is untouched.

const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

/** True (and prints a cancel notice) when the user aborted a clack prompt. */
function cancelled(v: unknown): v is symbol {
  if (p.isCancel(v)) {
    p.cancel("已取消");
    return true;
  }
  return false;
}

/** clack `select` options for the current peers (value = url). */
export function peerChoices(peers: PeerRow[]): { value: string; label: string; hint: string }[] {
  return peers.map((pr) => ({
    value: pr.url,
    label: pr.label ? `${pr.label} (${pr.url})` : pr.url,
    hint: pr.enabled ? "enabled" : "disabled",
  }));
}

/** clack `select` options for issued credentials (value = full token). */
export function grantChoices(grants: GrantRow[]): { value: string; label: string; hint: string }[] {
  return grants.map((g) => ({
    value: g.token,
    label: maskToken(g.token),
    hint: g.peer_url ?? "(unknown)",
  }));
}

/** Validate a port string: an integer in 1–65535. Returns an error message or undefined. */
export function validatePort(s: string | undefined): string | undefined {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return "端口必须是 1-65535 的整数";
  return undefined;
}

/** Validate a duration string parses to a positive interval (e.g. 30s, 5m). */
export function validateInterval(s: string | undefined): string | undefined {
  return parseDuration(s, -1) > 0 ? undefined : "请输入有效的时长 (如 30s, 5m)";
}

const required = (v: string | undefined) => (v && v.trim() ? undefined : "必填");

async function serverWizard(db: ReturnType<typeof openMetahub>): Promise<void> {
  const working = { ...getServerConfig(db) };
  for (;;) {
    const field = await p.select({
      message: "服务器设置",
      options: [
        { value: "host", label: "Host", hint: working.host },
        { value: "port", label: "Port", hint: String(working.port) },
        { value: "interval", label: "同步间隔", hint: secs(working.syncIntervalMs) },
        { value: "auto", label: "Auto-sync", hint: working.autoSync ? "on" : "off" },
        { value: "save", label: "保存并返回" },
        { value: "back", label: "返回 (放弃修改)" },
      ],
    });
    if (cancelled(field) || field === "back") return;
    if (field === "save") {
      setServerConfig(db, working);
      p.note("restart --server to apply host/port/interval changes", "✓ 已保存");
      return;
    }
    if (field === "host") {
      const v = await p.text({ message: "Host", initialValue: working.host });
      if (cancelled(v)) return;
      working.host = v;
    } else if (field === "port") {
      const v = await p.text({ message: "Port", initialValue: String(working.port), validate: validatePort });
      if (cancelled(v)) return;
      working.port = Number(v);
    } else if (field === "interval") {
      const v = await p.text({ message: "同步间隔 (如 30s, 5m)", initialValue: secs(working.syncIntervalMs), validate: validateInterval });
      if (cancelled(v)) return;
      working.syncIntervalMs = parseDuration(v, working.syncIntervalMs);
    } else if (field === "auto") {
      const v = await p.confirm({ message: "启用 auto-sync?", initialValue: working.autoSync });
      if (cancelled(v)) return;
      working.autoSync = v;
    }
  }
}

async function peerWizard(db: ReturnType<typeof openMetahub>): Promise<void> {
  const node = getNodeId(db);
  for (;;) {
    const action = await p.select({
      message: "同步设备",
      options: [
        { value: "add", label: "添加设备", hint: "对方地址 + 配对码" },
        { value: "code", label: "生成本机配对码" },
        { value: "list", label: "列出设备" },
        { value: "rm", label: "移除设备" },
        { value: "toggle", label: "启用 / 禁用设备" },
        { value: "sync", label: "立即同步全部" },
        { value: "back", label: "返回" },
      ],
    });
    if (cancelled(action) || action === "back") return;
    try {
      if (action === "add") {
        const url = await p.text({ message: "对方服务器地址", placeholder: "http://192.168.1.10:7777", validate: required });
        if (cancelled(url)) continue;
        const code = await p.text({ message: "配对码", validate: required });
        if (cancelled(code)) continue;
        const selfUrl = await p.text({ message: "本机可达地址 (可选, 留空则单向)" });
        if (cancelled(selfUrl)) continue;
        const s = p.spinner();
        s.start("配对中…");
        try {
          const r = await performPairing(db, node, url, code, selfUrl || undefined);
          const sync = await syncPeer(db, r.url);
          s.stop(`✓ 已配对 ${r.url} (node ${r.node_id})`);
          p.note(syncLine(sync), "同步结果");
        } catch (e) {
          s.stop(`✗ ${(e as Error).message}`);
        }
      } else if (action === "code") {
        const code = generatePairingCode(db);
        p.note(`配对码: ${code.code}\n有效至: ${iso(code.exp)}`, "本机配对码");
      } else if (action === "list") {
        const rows = listPeers(db).map(peerView);
        p.note(rows.length ? table(rows) : "(无设备)", "设备列表");
      } else if (action === "rm") {
        const peers = listPeers(db);
        if (!peers.length) {
          p.note("(无设备)");
          continue;
        }
        const url = await p.select({ message: "选择要移除的设备", options: peerChoices(peers) });
        if (cancelled(url)) continue;
        p.note(removePeer(db, url) ? `✓ 已移除 ${url}` : "未找到该设备");
      } else if (action === "toggle") {
        const peers = listPeers(db);
        if (!peers.length) {
          p.note("(无设备)");
          continue;
        }
        const url = await p.select({ message: "选择设备", options: peerChoices(peers) });
        if (cancelled(url)) continue;
        const cur = peers.find((x) => x.url === url);
        const en = await p.confirm({ message: "启用该设备?", initialValue: cur ? !!cur.enabled : true });
        if (cancelled(en)) continue;
        setPeerEnabled(db, url, en);
        p.note(`✓ ${en ? "已启用" : "已禁用"} ${url}`);
      } else if (action === "sync") {
        const s = p.spinner();
        s.start("同步中…");
        const r = await syncAllPeers(db);
        s.stop("同步完成");
        p.note(r.length ? r.map(syncLine).join("\n") : "(无启用的设备)", "同步结果");
      }
    } catch (e) {
      p.note(`✗ ${(e as Error).message}`, "错误");
    }
  }
}

async function grantWizard(db: ReturnType<typeof openMetahub>): Promise<void> {
  for (;;) {
    const grants = listGrants(db);
    p.note(grants.length ? table(grants.map(grantView)) : "(无已签发凭据)", "已签发凭据");
    if (!grants.length) return;
    const token = await p.select({
      message: "选择要吊销的凭据",
      options: [...grantChoices(grants), { value: "__back__", label: "返回" }],
    });
    if (cancelled(token) || token === "__back__") return;
    const ok = await p.confirm({ message: `确认吊销 ${maskToken(token)}?`, initialValue: false });
    if (cancelled(ok) || !ok) continue;
    const n = revokeGrant(db, token);
    p.note(n > 0 ? `✓ 已吊销 ${n} 条` : "无匹配凭据");
  }
}

async function wizard(db: ReturnType<typeof openMetahub>): Promise<void> {
  p.intro("Metahub 配置");
  for (;;) {
    const choice = await p.select({
      message: "选择操作",
      options: [
        { value: "server", label: "服务器设置", hint: "host / port / 同步间隔 / auto-sync" },
        { value: "peers", label: "同步设备", hint: "配对 / 列出 / 移除 / 同步" },
        { value: "grants", label: "已签发凭据", hint: "列出 / 吊销" },
        { value: "exit", label: "退出" },
      ],
    });
    if (cancelled(choice) || choice === "exit") {
      p.outro("再见");
      return;
    }
    if (choice === "server") await serverWizard(db);
    else if (choice === "peers") await peerWizard(db);
    else if (choice === "grants") await grantWizard(db);
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
