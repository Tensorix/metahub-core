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
  getPeer,
  removePeer,
  setPeerEnabled,
  syncPeer,
  syncAllPeers,
  addAndSyncStoragePeer,
  rotateStoragePeer,
  type RotateOutcome,
  type PeerRow,
} from "../../core/sync/peers.ts";
import { type S3Config } from "../../core/sync/storage.ts";
import { encodeRecoveryCode } from "../../core/sync/recovery.ts";
import { fromB64 } from "../../core/sync/e2ee.ts";
import { decodeEnroll } from "../../core/sync/enroll.ts";
import {
  listDevices,
  refreshBucketPresence,
  resolveDevicePresence,
  type BucketPresenceResult,
  type DeviceView,
} from "../../core/sync/devices.ts";
import { provisionR2Bucket } from "../../core/sync/edge-service.ts";
import {
  cfOAuthConfigured,
  discoverAccounts,
  openBrowser,
  startCfLogin,
} from "../../core/sync/cf-oauth.ts";
import { anchorsDispatch } from "./cache.ts";
import { runEdgeDeploy, runEdgeConnect, runEdgeRotateKeys } from "./edge.ts";
import { putBucketCors } from "../../core/sync/storage-s3-bun.ts";
import { MhError } from "../../core/errors.ts";
import { print, table, guard, warn } from "../output.ts";
import * as p from "@clack/prompts";

// Single command, positional dispatch. citty subCommands are unusable here for
// two reasons: a parent `run` double-executes alongside a matched subcommand
// (see token.ts), and citty treats the first non-dash token — including flag
// *values* like the 7777 in `config --port 7777` — as the subcommand name.
// Supports both an interactive wizard (`mh config`, no args, on a TTY) and
// direct flags (`mh config --port 7777`, `mh config peer add --url ... --code ...`).

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : "");
const isTTY = () => process.stdout.isTTY && process.stdin.isTTY;

/** Bun global prompt(); returns trimmed input, or `def` when the user hits Enter. */
function ask(label: string, def?: string): string {
  const suffix = def != null && def !== "" ? ` [${def}]` : "";
  const raw = globalThis.prompt(`${label}${suffix}:`);
  const val = (raw ?? "").trim();
  return val === "" && def != null ? def : val;
}

/** A flag value, or an interactive prompt fallback on a TTY, else an
 *  `invalid_input` error carrying the full usage line so non-interactive
 *  callers (agents, scripts) see what to pass without consulting docs. */
function flagOrAsk(flag: unknown, label: string, usage?: string): string {
  if (typeof flag === "string" && flag !== "") return flag;
  if (isTTY()) {
    const v = ask(label);
    if (v) return v;
  }
  throw new MhError("invalid_input", `missing --${label}` + (usage ? `\nusage: ${usage}` : ""));
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
      `  blob-quota:    ${fmtBytes(cfg.blobCacheQuotaBytes)}`,
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
    kind: p.kind,
    label: p.label ?? "",
    enabled: p.enabled ? "yes" : "no",
    status: p.last_status ?? "",
    last_attempt: iso(p.last_sync_at),
    last_success: iso(p.last_success_at),
  };
}

function applySet(db: ReturnType<typeof openMetahub>, args: Record<string, any>): void {
  const partial: Partial<ServerConfig> = {};
  if (typeof args.host === "string" && args.host !== "") partial.host = args.host;
  if (args.port != null && args.port !== "") partial.port = Number(args.port);
  if (args["sync-interval"] != null && args["sync-interval"] !== "")
    partial.syncIntervalMs = parseDuration(String(args["sync-interval"]), 30_000);
  if (args["auto-sync"] != null) partial.autoSync = parseBool(args["auto-sync"]);
  if (args["blob-quota"] != null && args["blob-quota"] !== "") {
    const q = parseBytes(String(args["blob-quota"]));
    if (q == null) throw new MhError("invalid_input", "invalid --blob-quota (e.g. 2gb, 500mb, 0)");
    partial.blobCacheQuotaBytes = q;
  }
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
      if (args.s3) return storagePeerAdd(db, args);
      const usage = "mh config device add --url <url> --code <code> [--self-url <url>]";
      const url = flagOrAsk(args.url, "url", usage);
      const code = flagOrAsk(args.code, "code", usage);
      const selfUrl = typeof args["self-url"] === "string" ? args["self-url"] : undefined;
      const r = await performPairing(db, node, url, code, selfUrl);
      const sync = await syncPeer(db, url);
      print({ paired: r, sync }, () => `paired with ${r.url} (node ${r.node_id}); ${syncLine(sync)}`);
      return;
    }
    case "code": {
      const c = generatePairingCode(db);
      print(c, () => `pairing code: ${c.code}\nexpires:      ${iso(c.exp)}\n(redeem with: mh config device add --url <this-server-url> --code ${c.code})`);
      return;
    }
    case "list":
      print(listPeers(db).map(peerView), (() => {
        const rows = listPeers(db).map(peerView);
        return rows.length ? table(rows) : "(no peers)";
      }));
      return;
    case "rm": {
      const url = flagOrAsk(args.url, "url", "mh config peer rm --url <url>");
      print({ ok: removePeer(db, url) }, () => `removed ${url}`);
      return;
    }
    case "enable":
    case "disable": {
      const url = flagOrAsk(args.url, "url", `mh config peer ${action} --url <url>`);
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
    case "recovery": {
      // Deliberately secret-revealing (unlike `config show`): prints the master
      // key as a printable card. The last-resort backup for "every device is
      // gone AND the passphrase is forgotten".
      const usage = "mh config backup recovery --url s3://<bucket>/<prefix>";
      const url = flagOrAsk(args.url, "url", usage);
      const peer = getPeer(db, url);
      if (!peer || peer.kind !== "s3" || !peer.config)
        throw new MhError("not_found", `no S3 storage peer at '${url}' (see: mh config backup list)`);
      const config = JSON.parse(peer.config) as S3Config;
      if (!config.encrypt || !config.masterKey)
        throw new MhError("invalid_input", "plaintext bucket has no master key — nothing to back up");
      const code = await encodeRecoveryCode(fromB64(config.masterKey));
      print({ url, code }, () => recoveryCard(url, config.bucket, code));
      return;
    }
    case "rotate": {
      const usage =
        "mh config backup rotate --url s3://<bucket>/<prefix> [--access-key <id> --secret-key <key>] [--new-passphrase <pw>] [--old-passphrase <pw>] [--recovery-code <MH1-…>]";
      const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
      const hasFlags =
        str(args["access-key"]) || str(args["secret-key"]) || str(args["new-passphrase"]) ||
        str(args["old-passphrase"]) || str(args["recovery-code"]);
      if (!hasFlags && isTTY()) return rotateWizardFor(db, str(args.url));
      const url = flagOrAsk(args.url, "url", usage);
      const r = await rotateStoragePeer(db, url, {
        accessKeyId: str(args["access-key"]),
        secretAccessKey: str(args["secret-key"]),
        newPassphrase: str(args["new-passphrase"]),
        oldPassphrase: str(args["old-passphrase"]),
        recoveryCode: str(args["recovery-code"]),
      });
      print(r, () => rotateLines(r));
      return;
    }
    case "cors": {
      // Open the bucket's CORS to a browser shell origin so a phone can talk to
      // it directly (the desktop does it — a browser can't bootstrap its own CORS).
      const usage =
        "mh config backup cors --url s3://<bucket>/<prefix> --allow <origin>[,<origin2>...]";
      const url = flagOrAsk(args.url, "url", usage);
      const peer = getPeer(db, url);
      if (!peer || peer.kind !== "s3" || !peer.config) {
        throw new MhError("not_found", `no S3 storage peer at '${url}' (see: mh config backup list)`);
      }
      const config = JSON.parse(peer.config) as S3Config;
      const origins = String(flagOrAsk(args.allow, "allow", usage))
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await putBucketCors(config, origins);
      print({ url, corsOrigins: origins }, () => `CORS set on ${url} for: ${origins.join(", ")}`);
      return;
    }
    default:
      throw new MhError(
        "invalid_input",
        `unknown peer action '${action}' (add|code|list|rm|enable|disable|sync|cors|rotate|recovery)`,
      );
  }
}

/** Printable recovery card (human output of `peer recovery` and the wizard). */
function recoveryCard(url: string, bucket: string, code: string): string {
  const groups = code.split("-"); // ["MH1", ...14 groups]
  const l1 = groups.slice(0, 8).join("-");
  const l2 = "    " + groups.slice(8).join("-");
  return [
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    " Metahub 恢复码",
    ` 存储桶: ${bucket}  (${url})`,
    ` 生成于: ${new Date().toISOString().slice(0, 10)}`,
    "",
    ` ${l1}`,
    ` ${l2}`,
    "",
    " 这串代码等于你全部数据的钥匙。忘记加密口令时,凭它可恢复",
    " 数据并设置新口令。请打印或抄写,放在安全的地方;不要保存",
    " 在会被同步的笔记里。任何拿到它的人都能读取你的全部数据。",
    "",
    " 使用: mh config backup connect --enroll <接入码> --recovery-code <此码>",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  ].join("\n");
}

/** Human summary for a flag-driven rotate (agents read the JSON instead). */
function rotateLines(r: RotateOutcome): string {
  const lines = [
    `rotated ${[r.rotatedCredentials ? "credentials" : null, r.rotatedPassphrase ? "passphrase" : null].filter(Boolean).join(" + ")} on ${r.url}`,
    r.keyVerified === "verified" ? "master key verified against bucket ciphertext" : null,
    r.keyVerified === "no_ciphertext"
      ? "⚠️  bucket held no ciphertext to verify the key against — proceeded"
      : null,
    r.sync.ok
      ? `post-rotate sync ok (${syncLine(r.sync)})`
      : `⚠️  post-rotate sync FAILED: ${r.sync.error} — credentials saved; retry: mh sync`,
    r.rotatedCredentials ? "you can now DISABLE the old keys at the storage provider" : null,
    r.rotatedPassphrase
      ? "passphrase changed: already-configured devices keep working; only NEW devices need the new passphrase"
      : null,
    "re-attach other devices with the fresh enroll code below (data and progress survive):",
    `  mh config backup connect --enroll ${r.enroll}`,
    "note: data a lost device already synced cannot be wiped remotely — it only loses access to FUTURE data",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Interactive rotate (bare `mh config backup rotate` on a TTY + the wizard menu). */
async function rotateWizardFor(
  db: ReturnType<typeof openMetahub>,
  presetUrl?: string,
): Promise<void> {
  const s3peers = listPeers(db).filter((x) => x.kind === "s3" && x.config);
  if (!s3peers.length) {
    p.note("(没有已配置的存储桶)");
    return;
  }
  let url = presetUrl;
  if (!url) {
    const sel = await p.select({ message: "选择要轮换的存储桶", options: peerChoices(s3peers) });
    if (cancelled(sel)) return;
    url = sel;
  }
  const peer = s3peers.find((x) => x.url === url);
  if (!peer?.config) {
    p.note(`未找到存储桶 ${url}`);
    return;
  }
  const config = JSON.parse(peer.config) as S3Config;
  p.note(
    [
      "适用于「手机丢了 / 密钥泄露 / 想换口令」。",
      "请先在存储服务商控制台**新建**一把 Access Key——先不要删除旧的,",
      "完成后再停用。中途任何失败,旧钥匙都还能用;重跑本向导即可续接。",
    ].join("\n"),
    "轮换存储密钥",
  );
  const wantCreds = await p.confirm({ message: "更换存储访问密钥 (Access Key)?", initialValue: true });
  if (cancelled(wantCreds)) return;
  let accessKeyId: string | undefined;
  let secretAccessKey: string | undefined;
  if (wantCreds) {
    const ak = await p.text({ message: "新 Access Key ID", validate: required });
    if (cancelled(ak)) return;
    const sk = await p.password({ message: "新 Secret Access Key", validate: required });
    if (cancelled(sk)) return;
    accessKeyId = ak;
    secretAccessKey = sk;
  }
  let newPassphrase: string | undefined;
  let oldPassphrase: string | undefined;
  let recoveryCode: string | undefined;
  if (config.encrypt) {
    const wantPw = await p.confirm({ message: "同时更换加密口令?", initialValue: false });
    if (cancelled(wantPw)) return;
    if (wantPw) {
      const pw1 = await p.password({ message: "新口令", validate: required });
      if (cancelled(pw1)) return;
      const pw2 = await p.password({
        message: "再输一次确认",
        validate: (v) => (v === pw1 ? undefined : "两次输入不一致"),
      });
      if (cancelled(pw2)) return;
      newPassphrase = pw1;
      if (!config.masterKey) {
        const src = await p.select({
          message: "本机没有缓存密钥,需要一个来源",
          options: [
            { value: "recovery", label: "输入恢复码", hint: "MH1- 开头的 14 组代码" },
            { value: "old", label: "输入当前口令" },
          ],
        });
        if (cancelled(src)) return;
        if (src === "recovery") {
          const rc = await p.text({ message: "恢复码", validate: required });
          if (cancelled(rc)) return;
          recoveryCode = rc;
        } else {
          const op = await p.password({ message: "当前口令", validate: required });
          if (cancelled(op)) return;
          oldPassphrase = op;
        }
      }
    }
  }
  if (!wantCreds && !newPassphrase) {
    p.note("没有要更改的内容");
    return;
  }
  const s = p.spinner();
  s.start("验证新凭据并轮换…");
  try {
    const r = await rotateStoragePeer(db, url, {
      accessKeyId,
      secretAccessKey,
      newPassphrase,
      oldPassphrase,
      recoveryCode,
    });
    s.stop("✓ 轮换完成");
    p.note(
      [
        r.rotatedCredentials ? "• 现在可以到存储服务商控制台停用旧密钥了。" : null,
        r.rotatedPassphrase
          ? "• 口令已更换:已配置设备无需重输,只有新加入的设备需要新口令。"
          : null,
        "• 其他设备用下面的新接入码重新接入(数据与同步进度不受影响)。",
        "• 丢失设备此前已同步的数据无法远程抹除;它只是无法再获取之后的数据。",
        r.sync.ok
          ? null
          : `⚠️ 轮换后的首次同步失败: ${r.sync.error}(凭据已保存;稍后重试 mh sync)`,
      ]
        .filter(Boolean)
        .join("\n"),
      "下一步",
    );
    p.note(r.enroll, "新接入码 (含新密钥,勿公开;不含口令)");
  } catch (e) {
    s.stop(`✗ ${(e as Error).message}`);
    p.note("中途失败不影响旧钥匙;修正后重跑本向导即可续接。", "提示");
  }
}

function syncLine(o: { url: string; ok: boolean; pushed?: number; pulled?: number; error?: string }) {
  return o.ok ? `${o.url}: pushed ${o.pushed}, pulled ${o.pulled}` : `${o.url}: error — ${o.error}`;
}

/**
 * Add an S3-compatible storage peer (R2/MinIO/S3) as dumb store-and-forward.
 * Delegates to the shared `addAndSyncStoragePeer` (provision → persist → first
 * sync) so the CLI and the WebUI server endpoint stay identical. The CLI runs on
 * the data home (this machine's hub), so it marks this node the bucket publisher.
 */
async function storagePeerAdd(
  db: ReturnType<typeof openMetahub>,
  args: Record<string, any>,
): Promise<void> {
  const usage =
    "mh config backup connect --enroll <code>  |  --endpoint <url> --bucket <name> --access-key <id> --secret-key <key> [--prefix <p>] [--region <r>] [--passphrase <pw>] [--no-encrypt]  |  --provision-r2 --bucket <name> --yes [--cf-account-id <id> --cf-api-token <t>]";

  // `--provision-r2`: create the named bucket in the user's Cloudflare account
  // first (OAuth or --cf-api-token), then continue the ordinary attach flow with
  // the R2 endpoint pre-filled. S3 credentials can't be minted via OAuth (no
  // scope exists) — the user pastes them from the dashboard's R2 API Tokens page.
  let provisionedEndpoint: string | undefined;
  let provisionedBucket: string | undefined;
  if (args["provision-r2"]) {
    if (!args.yes && !isTTY())
      throw new MhError("invalid_input", `--provision-r2 creates a remote resource; pass --yes to confirm\nusage: ${usage}`);
    const cfToken = typeof args["cf-api-token"] === "string" && args["cf-api-token"] ? args["cf-api-token"] : null;
    let accountId = typeof args["cf-account-id"] === "string" && args["cf-account-id"] ? args["cf-account-id"] : undefined;
    let apiToken: string;
    if (cfToken) {
      if (!accountId) throw new MhError("invalid_input", `missing --cf-account-id\nusage: ${usage}`);
      apiToken = cfToken;
    } else if (cfOAuthConfigured()) {
      const login = await startCfLogin();
      print({ authUrl: login.authUrl }, () => `opening Cloudflare to authorize…\nif the browser didn't open, visit:\n${login.authUrl}`);
      openBrowser(login.authUrl);
      const token = await login.waitForToken();
      apiToken = token.accessToken;
      if (!accountId) {
        const accounts = await discoverAccounts(token.accessToken);
        if (accounts.length === 0) throw new MhError("invalid_input", "该 Cloudflare 登录下没有可用账号");
        if (accounts.length > 1)
          throw new MhError(
            "invalid_input",
            "该登录关联多个 Cloudflare 账号，请用 --cf-account-id 指定其一：\n" +
              accounts.map((a) => `  ${a.id}  ${a.name}`).join("\n"),
          );
        accountId = accounts[0]!.id;
      }
    } else {
      throw new MhError("invalid_input", "未配置 Cloudflare OAuth，请提供 --cf-account-id <id> --cf-api-token <token>");
    }
    if (!args.yes && isTTY()) {
      const ok = ask(`create R2 bucket '${typeof args.bucket === "string" ? args.bucket : "(default name)"}' in Cloudflare account ${accountId}? it will NOT be auto-deleted on disconnect (yes/no)`, "no");
      if (ok.toLowerCase() !== "yes" && ok.toLowerCase() !== "y")
        throw new MhError("invalid_input", "cancelled");
    }
    const r2 = await provisionR2Bucket(db, {
      accountId,
      apiToken,
      bucketName: typeof args.bucket === "string" && args.bucket ? args.bucket : undefined,
      confirmed: true,
    });
    provisionedEndpoint = r2.endpoint;
    provisionedBucket = r2.bucketName;
    print(
      { r2: r2 },
      () =>
        `R2 bucket ${r2.status}: ${r2.bucketName} (${r2.endpoint})\n` +
        `next: create S3 credentials at ${r2.credentialsUrl} and pass/enter them below\n` +
        `note: the bucket is never auto-deleted; removing this peer later leaves it untouched`,
    );
  }

  // `--enroll <code>` joins an existing bucket from the same token the WebUI QR /
  // 「添加设备」 carries (endpoint + creds, never the passphrase). Explicit flags
  // still win, so a code can be tweaked inline. An enroll join is a *secondary*
  // device → low publisher priority; a hand-typed setup is the data home (100).
  const enrolled =
    typeof args.enroll === "string" && args.enroll ? decodeEnroll(args.enroll) : null;
  const pick = (flag: unknown, fromCode: string | undefined, label: string): string =>
    typeof flag === "string" && flag !== ""
      ? flag
      : fromCode != null && fromCode !== ""
        ? fromCode
        : flagOrAsk(flag, label, usage);

  const endpoint = pick(args.endpoint, provisionedEndpoint ?? enrolled?.endpoint, "endpoint");
  const bucket = pick(args.bucket, provisionedBucket ?? enrolled?.bucket, "bucket");
  const accessKeyId = pick(args["access-key"], enrolled?.accessKeyId, "access-key");
  const secretAccessKey = pick(args["secret-key"], enrolled?.secretAccessKey, "secret-key");
  const prefix =
    typeof args.prefix === "string" && args.prefix ? args.prefix : enrolled?.prefix || "metahub";
  const region =
    typeof args.region === "string" && args.region ? args.region : enrolled?.region || "auto";
  // --no-encrypt always forces plaintext; else honor the code's flag, default on.
  const encrypt = args.encrypt === false ? false : enrolled?.encrypt ?? true;
  // A recovery code substitutes for the passphrase ("forgot passphrase" join):
  // it carries the master key itself and never touches the bucket's envelope.
  const recoveryCode =
    typeof args["recovery-code"] === "string" && args["recovery-code"]
      ? args["recovery-code"]
      : undefined;
  const passphrase =
    encrypt && !recoveryCode ? flagOrAsk(args.passphrase, "passphrase", usage) : undefined;

  const { url, config, sync } = await addAndSyncStoragePeer(db, {
    endpoint, region, bucket, prefix, accessKeyId, secretAccessKey,
    virtualHostedStyle: enrolled?.virtualHostedStyle,
    encrypt, passphrase, recoveryCode,
    publish: true, priority: enrolled ? 10 : 100, label: bucket,
  });

  // Optional one-shot: open CORS for a browser shell so a phone can connect
  // straight after scanning. Best-effort — the peer is already added; a failure
  // (e.g. credentials lack PutBucketCors) is reported, not fatal.
  let cors: { origins: string[]; ok: boolean; error?: string } | undefined;
  if (typeof args["cors-origin"] === "string" && args["cors-origin"]) {
    const origins = args["cors-origin"].split(",").map((s: string) => s.trim()).filter(Boolean);
    try {
      await putBucketCors(config, origins);
      cors = { origins, ok: true };
    } catch (e) {
      cors = { origins, ok: false, error: (e as Error).message };
    }
  }

  print(
    { added: url, encrypted: encrypt, sync, ...(cors ? { cors } : {}) },
    () => {
      let line = `added storage peer ${url} (${encrypt ? "encrypted" : "PLAINTEXT — trusted storage only"}); ${syncLine(sync)}`;
      if (cors?.ok) line += `\nCORS opened for: ${cors.origins.join(", ")}`;
      else if (cors) line += `\n⚠️  CORS not set (retry: mh config backup cors --url ${url} --allow ${cors.origins.join(",")}): ${cors.error}`;
      return line;
    },
  );
}

const maskToken = (t: string) => (t.length > 10 ? `${t.slice(0, 8)}…` : t);

// --- unified device roster (`mh config device …`) ----------------------------

const CHANNEL_LABEL: Record<string, string> = {
  paired_out: "paired",
  grant_in: "grant",
  oplog: "history",
  bucket_presence: "confirmed-bucket",
};

function deviceRow(d: DeviceView) {
  const joined = [...new Set(d.channels.map((c) => CHANNEL_LABEL[c.kind] ?? c.kind))].join("+");
  return {
    device: (d.self ? "* " : "") + (d.label ?? d.nodeId ?? "(unknown)"),
    node: d.nodeId ?? "",
    joined: joined || "-",
    last_activity: iso(d.lastActivityAt),
    removable:
      d.revocable === "yes"
        ? "yes"
        : d.revocable === "bucket_rotate"
          ? `rotate ${d.revocationSources.join(",")}`
          : d.revocable === "unknown"
            ? "unknown source"
            : "-",
  };
}

/** JSON view: grant tokens masked to their bare 8-char prefix — enough for
 *  display AND for `mh config grant revoke` (which accepts a unique prefix). */
function deviceJson(d: DeviceView) {
  return {
    ...d,
    channels: d.channels.map((c) => (c.kind === "grant_in" ? { ...c, ref: c.ref.slice(0, 8) } : c)),
  };
}

async function deviceDispatch(
  db: ReturnType<typeof openMetahub>,
  action: string,
  args: Record<string, any>,
): Promise<void> {
  switch (action) {
    // Pairing lives here in the documented tree (a device joins the workspace);
    // `config peer add/code` remain the hidden aliases of the same paths.
    case "add":
    case "code":
      return peerDispatch(db, action, args);
    case "list": {
      let devices = listDevices(db);
      let presence: BucketPresenceResult[] | undefined;
      if (args.refresh) {
        presence = await Promise.all(
          listPeers(db)
            .filter((x) => x.kind === "s3" && x.enabled)
            .map(async (p): Promise<BucketPresenceResult> => {
              try {
                return {
                  url: p.url,
                  nodes: await refreshBucketPresence(db, p.url),
                };
              } catch (e) {
                return { url: p.url, error: (e as Error).message };
              }
            }),
        );
        devices = resolveDevicePresence(devices, presence);
      }
      print({ devices: devices.map(deviceJson), ...(presence ? { presence } : {}) }, () => {
        let out = table(devices.map(deviceRow));
        for (const b of presence ?? []) {
          out += b.error
            ? `\n\nbucket ${b.url}: refresh failed — ${b.error}`
            : `\n\nbucket ${b.url} presence:\n${table(
                (b.nodes as { nodeId: string; inBucket: boolean; leaseLiveUntil: number | null }[]).map(
                  (n) => ({
                    node: n.nodeId,
                    in_bucket: n.inBucket ? "yes" : "no",
                    recently_online: n.leaseLiveUntil ? `lease until ${iso(n.leaseLiveUntil)}` : "-",
                  }),
                ),
              )}`;
        }
        return out;
      });
      return;
    }
    case "revoke": {
      const usage = "mh config device revoke --node <nodeId>";
      const nodeId = flagOrAsk(args.node, "node", usage);
      const devices = listDevices(db);
      const target = devices.find((d) => d.nodeId === nodeId);
      if (!target) throw new MhError("not_found", `no known device with node id '${nodeId}'`);
      if (target.self) throw new MhError("invalid_input", "refusing to revoke this device itself");
      const grants = listGrants(db).filter((g) => g.node_id === nodeId);
      for (const g of grants) revokeGrant(db, g.token);
      const peers = listPeers(db).filter((p) => p.node_id === nodeId);
      for (const p of peers) removePeer(db, p.url);
      const bucketBound = target.revocable === "bucket_rotate" || grants.length + peers.length === 0;
      print(
        { node: nodeId, revokedGrants: grants.length, removedPeers: peers.length, bucketBound },
        () => {
          const lines = [
            `revoked ${grants.length} grant(s), removed ${peers.length} peer(s) for ${nodeId}`,
            "data it already synced stays on that device — it cannot be wiped remotely",
          ];
          if (bucketBound)
            lines.push(
              "this device shares the bucket key: to cut its access, disable the old keys at the provider and run `mh config backup rotate`",
            );
          return lines.join("\n");
        },
      );
      return;
    }
    default:
      throw new MhError("invalid_input", `unknown device action '${action}' (add|code|list|revoke)`);
  }
}

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
      const token = flagOrAsk(args.token, "token", "mh config grant revoke --token <token>");
      const n = revokeGrant(db, token);
      print({ revoked: n }, () => (n > 0 ? `revoked ${n} credential(s)` : "no matching credential"));
      return;
    }
    default:
      throw new MhError("invalid_input", `unknown grant action '${action}' (list|revoke)`);
  }
}

// --- config namespaces (the user-facing tree) --------------------------------
// `mh config backup|device|edge|server` is the documented surface; the older
// `peer|grant|set` sections stay as hidden aliases (agents/scripts keep
// working) but no longer appear in help.

/** Cloud backup (the S3/R2 sync bucket family + workspace blob anchors). */
async function backupDispatch(
  db: ReturnType<typeof openMetahub>,
  action: string,
  args: Record<string, any>,
): Promise<void> {
  switch (action) {
    case "connect":
      return storagePeerAdd(db, args);
    case "rotate":
    case "recovery":
    case "cors":
      return peerDispatch(db, action, args);
    case "anchors": {
      const sub = typeof args.sub === "string" && args.sub ? args.sub : undefined;
      const value = typeof args.value === "string" && args.value ? args.value : undefined;
      return anchorsDispatch(db, sub, value, args);
    }
    case "list": {
      const rows = listPeers(db).filter((x) => x.kind === "s3").map(peerView);
      print(rows, () => (rows.length ? table(rows) : "(no backup buckets)"));
      return;
    }
    default:
      throw new MhError(
        "invalid_input",
        `unknown backup action '${action}' (connect|list|rotate|recovery|cors|anchors)`,
      );
  }
}

/** The always-on edge component (Cloudflare Worker+D1 / compatible hosts). */
async function edgeConfigDispatch(action: string, args: Record<string, any>): Promise<void> {
  switch (action) {
    case "deploy":
      return runEdgeDeploy(args);
    case "connect":
      return runEdgeConnect(args);
    case "rotate-keys":
      return runEdgeRotateKeys(args);
    default:
      throw new MhError(
        "invalid_input",
        `unknown edge action '${action}' (deploy|connect|rotate-keys) — status/pull are tools: mh edge status`,
      );
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

/** Human byte size, e.g. 2.0 GB. */
function fmtBytes(n: number): string {
  if (n <= 0) return "disabled";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Parse a byte size accepting suffixes (kb/mb/gb, case-insensitive) or a plain
 *  byte count. "0"/"off"/"none" disable the quota. Returns null when unparseable. */
function parseBytes(s: string | undefined): number | null {
  if (s == null) return null;
  const t = s.trim().toLowerCase();
  if (t === "" ) return null;
  if (t === "0" || t === "off" || t === "none" || t === "disabled") return 0;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/.exec(t);
  if (!m) return null;
  const v = Number(m[1]);
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[m[2] ?? "b"]!;
  return Math.round(v * mult);
}

/** Validate a byte-size string (suffix or plain bytes, or 0/off to disable). */
export function validateBytes(s: string | undefined): string | undefined {
  return parseBytes(s) != null ? undefined : "请输入字节数或带单位 (如 2gb, 500mb, 0 关闭)";
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
        { value: "quota", label: "缓存配额", hint: fmtBytes(working.blobCacheQuotaBytes) },
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
    } else if (field === "quota") {
      const v = await p.text({
        message: "本地缓存配额 (如 2gb, 500mb, 0 关闭自动淘汰)",
        initialValue: fmtBytes(working.blobCacheQuotaBytes),
        validate: validateBytes,
      });
      if (cancelled(v)) return;
      working.blobCacheQuotaBytes = parseBytes(v) ?? working.blobCacheQuotaBytes;
    }
  }
}

/** One implementation, two wizard scopes: 设备 (pairing/roster) vs 同步存储桶
 *  (buckets/rotation/recovery). Branches outside a scope's menu are simply
 *  never selectable there. */
async function peerWizard(
  db: ReturnType<typeof openMetahub>,
  scope: "device" | "backup",
): Promise<void> {
  const node = getNodeId(db);
  for (;;) {
    const action = await p.select({
      message: scope === "device" ? "设备" : "同步存储桶",
      options:
        scope === "device"
          ? [
              { value: "add", label: "添加设备", hint: "对方地址 + 配对码" },
              { value: "code", label: "生成本机配对码" },
              { value: "list", label: "列出设备" },
              { value: "rm", label: "移除设备" },
              { value: "toggle", label: "启用 / 禁用设备" },
              { value: "grants", label: "吊销已签发凭据" },
              { value: "back", label: "返回" },
            ]
          : [
              { value: "add-s3", label: "连接存储桶 (S3/R2)", hint: "对象存储中转,免公网 IP" },
              { value: "join-code", label: "粘贴接入码加入存储", hint: "另一台设备「添加设备」里的码" },
              { value: "sync", label: "立即同步全部" },
              { value: "rotate", label: "轮换存储密钥 / 更换口令", hint: "手机丢了 / 密钥泄露时" },
              { value: "recovery", label: "导出恢复码", hint: "打印保存,口令忘了也能恢复" },
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
      } else if (action === "add-s3") {
        const endpoint = await p.text({
          message: "S3 endpoint",
          placeholder: "https://<account>.r2.cloudflarestorage.com",
          validate: required,
        });
        if (cancelled(endpoint)) continue;
        const bucket = await p.text({ message: "Bucket 名称", validate: required });
        if (cancelled(bucket)) continue;
        const region = await p.text({ message: "Region", initialValue: "auto" });
        if (cancelled(region)) continue;
        const accessKeyId = await p.text({ message: "Access Key ID", validate: required });
        if (cancelled(accessKeyId)) continue;
        const secretAccessKey = await p.password({ message: "Secret Access Key", validate: required });
        if (cancelled(secretAccessKey)) continue;
        const prefix = await p.text({ message: "路径前缀", initialValue: "metahub" });
        if (cancelled(prefix)) continue;
        const encrypt = await p.confirm({ message: "启用端到端加密? (强烈建议)", initialValue: true });
        if (cancelled(encrypt)) continue;
        let passphrase = "";
        if (encrypt) {
          const pw = await p.password({
            message: "加密口令 (新桶将以此创建,已有桶需输入相同口令)",
            validate: required,
          });
          if (cancelled(pw)) continue;
          passphrase = pw;
        } else {
          p.note("⚠️ 明文模式:段文件不加密,仅限你完全信任的存储 (如自建内网 MinIO)。", "警告");
        }
        const s = p.spinner();
        s.start("连接存储并配置…");
        try {
          // CLI runs on the data home → this node is the bucket publisher.
          const { url, sync } = await addAndSyncStoragePeer(db, {
            endpoint, region: region || "auto", bucket, prefix: prefix || "metahub",
            accessKeyId, secretAccessKey, encrypt, passphrase, publish: true, priority: 100, label: bucket,
          });
          s.stop(`✓ 已添加存储 ${url}`);
          p.note(syncLine(sync), "同步结果");
        } catch (e) {
          s.stop(`✗ ${(e as Error).message}`);
        }
      } else if (action === "join-code") {
        const codeIn = await p.text({
          message: "接入码",
          placeholder: "从另一台设备「添加设备」复制",
          validate: required,
        });
        if (cancelled(codeIn)) continue;
        let payload: ReturnType<typeof decodeEnroll>;
        try {
          payload = decodeEnroll(codeIn);
        } catch (e) {
          p.note(`✗ ${(e as Error).message}`, "无效的接入码");
          continue;
        }
        let passphrase = "";
        let recoveryCode: string | undefined;
        if (payload.encrypt !== false) {
          const how = await p.select({
            message: "解锁方式",
            options: [
              { value: "pw", label: "输入加密口令", hint: "与其他设备相同" },
              { value: "rc", label: "忘记口令 — 用恢复码", hint: "MH1- 开头的 14 组代码" },
            ],
          });
          if (cancelled(how)) continue;
          if (how === "pw") {
            const pw = await p.password({ message: "加密口令 (与其他设备相同)", validate: required });
            if (cancelled(pw)) continue;
            passphrase = pw;
          } else {
            const rc = await p.text({ message: "恢复码", validate: required });
            if (cancelled(rc)) continue;
            recoveryCode = rc;
          }
        }
        const s = p.spinner();
        s.start("连接存储并同步…");
        try {
          // Pasted enroll code → join as a secondary device (low publisher priority).
          const { url, sync } = await addAndSyncStoragePeer(db, {
            endpoint: payload.endpoint,
            region: payload.region || "auto",
            bucket: payload.bucket,
            prefix: payload.prefix || "metahub",
            accessKeyId: payload.accessKeyId,
            secretAccessKey: payload.secretAccessKey,
            virtualHostedStyle: payload.virtualHostedStyle,
            encrypt: payload.encrypt !== false,
            passphrase: passphrase || undefined,
            recoveryCode,
            publish: true,
            priority: 10,
            label: payload.bucket,
          });
          s.stop(`✓ 已加入存储 ${url}`);
          p.note(syncLine(sync), "同步结果");
        } catch (e) {
          s.stop(`✗ ${(e as Error).message}`);
        }
      } else if (action === "code") {
        const code = generatePairingCode(db);
        p.note(`配对码: ${code.code}\n有效至: ${iso(code.exp)}`, "本机配对码");
      } else if (action === "list") {
        const rows = listDevices(db).map(deviceRow);
        p.note(rows.length ? table(rows) : "(无设备)", "设备列表");
      } else if (action === "grants") {
        await grantWizard(db);
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
      } else if (action === "rotate") {
        await rotateWizardFor(db);
      } else if (action === "recovery") {
        const s3peers = listPeers(db).filter((x) => x.kind === "s3" && x.config);
        if (!s3peers.length) {
          p.note("(没有已配置的存储桶)");
          continue;
        }
        const url =
          s3peers.length === 1
            ? s3peers[0]!.url
            : await p.select({ message: "选择存储桶", options: peerChoices(s3peers) });
        if (cancelled(url)) continue;
        const cfg = JSON.parse(s3peers.find((x) => x.url === url)!.config!) as S3Config;
        if (!cfg.encrypt || !cfg.masterKey) {
          p.note("该桶未加密,没有需要备份的密钥。");
          continue;
        }
        const code = await encodeRecoveryCode(fromB64(cfg.masterKey));
        p.note(recoveryCard(url as string, cfg.bucket, code), "恢复码 (请打印或抄写)");
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
      message: "选择要配置的对象",
      options: [
        { value: "server", label: "服务器设置", hint: "host / port / 同步间隔 / auto-sync" },
        { value: "device", label: "设备", hint: "配对 / 列出 / 移除 / 吊销凭据" },
        { value: "backup", label: "同步存储桶", hint: "存储桶 / 更换密钥 / 恢复码" },
        { value: "exit", label: "退出" },
      ],
    });
    if (cancelled(choice) || choice === "exit") {
      p.outro("再见");
      return;
    }
    if (choice === "server") await serverWizard(db);
    else if (choice === "device") await peerWizard(db, "device");
    else if (choice === "backup") await peerWizard(db, "backup");
  }
}

/** Scoped usage for the positional compatibility dispatcher. index.ts
 * intercepts `mh config [section [action]] --help` before citty renders the
 * monolithic root arg set, so each surface shows only relevant concepts.
 * Returns null for an UNKNOWN section — the caller must then fail with
 * invalid_input (exit 2, stderr), never print the error as successful help. */
export function configScopedHelp(section?: string, action?: string): string | null {
  if (!section) {
    return `Configure the workspace

USAGE
  mh config                         Interactive server/device/backup wizard
  mh config show                    Print the effective configuration
  mh config server [OPTIONS]        Server settings
  mh config device <ACTION>         Pair, inspect, or revoke a device
  mh config backup <ACTION>         Connect and manage sync backups

Edge is an operational subsystem: use \`mh edge --help\`.`;
  }
  if (section === "show") {
    return `Print the effective configuration

USAGE
  mh config show`;
  }
  if (section === "server") {
    return `Configure the workspace main node

USAGE
  mh config server [--host <host>] [--port <port>]
                   [--sync-interval <30s|5m>] [--auto-sync <true|false>]
                   [--blob-quota <2gb|500mb|0>]`;
  }
  if (section === "device") {
    if (action === "add")
      return `Pair another device

USAGE
  mh config device add --url <url> --code <one-time-code> [--self-url <url>]`;
    if (action === "revoke")
      return `Revoke a device

USAGE
  mh config device revoke --node <node-id>`;
    return `Manage devices

USAGE
  mh config device add --url <url> --code <code>
  mh config device code
  mh config device list [--refresh]
  mh config device revoke --node <node-id>`;
  }
  if (section === "backup") {
    if (action === "connect")
      return `Connect a sync backup

USAGE
  mh config backup connect --endpoint <url> --bucket <name>
      --access-key <id> --secret-key <secret> [--region <region>]
      [--prefix <prefix>] [--passphrase <passphrase>] [--no-encrypt]
  mh config backup connect --enroll <code>`;
    if (action === "rotate")
      return `Rotate a sync backup's credentials or passphrase

USAGE
  mh config backup rotate --url <backup-url>
      [--access-key <id> --secret-key <secret>]
      [--new-passphrase <passphrase>]
      [--old-passphrase <passphrase> | --recovery-code <MH1-code>]`;
    return `Manage sync backups

USAGE
  mh config backup connect [OPTIONS]
  mh config backup list
  mh config backup rotate [OPTIONS]
  mh config backup recovery [--url <backup-url>]
  mh config backup cors --url <backup-url> --allow <origins>
  mh config backup anchors [list|add|rm|redundancy]`;
  }
  if (section === "edge")
    return `Deprecated compatibility alias.

Use \`mh edge --help\` (deploy, connect, status, pull, rotate).`;
  // Hidden aliases of the pre-namespace tree. They still DISPATCH (see the run
  // body), so `--help` on them must answer — a working command whose --help
  // says "unknown section" is a contract break, not a nudge.
  if (section === "set")
    return `Deprecated compatibility alias.

Use \`mh config server --help\` (host, port, sync-interval, auto-sync, blob-quota).`;
  if (section === "peer")
    return `Deprecated compatibility alias.

Devices (pairing):     \`mh config device --help\`
Sync storage buckets:  \`mh config backup --help\`
The old \`peer\` verbs keep working during the transition.`;
  if (section === "grant")
    return `Deprecated compatibility alias.

Use \`mh config device --help\` (issued credentials are listed and revoked there).`;
  return null;
}

export default defineCommand({
  meta: {
    name: "config",
    description:
      "Configure server settings, devices, and sync backups. " +
      "Run with no args for an interactive wizard, or drive sections directly: " +
      "`config server --port 7777` · `config device add --url <url> --code <code>` · " +
      "`config backup connect --endpoint … --bucket …`. Edge operations live under `mh edge`.",
  },
  args: {
    section: { type: "positional", required: false, description: "server | device | backup | show (omit for the interactive wizard)" },
    action: { type: "positional", required: false, description: "device: add|code|list|revoke · backup: connect|list|rotate|recovery|cors|anchors" },
    sub: { type: "positional", required: false, description: "backup anchors: list|add|rm|redundancy" },
    value: { type: "positional", required: false, description: "backup anchors redundancy: all|any" },
    host: { type: "string", description: "Bind address" },
    port: { type: "string", description: "Server port" },
    "sync-interval": { type: "string", description: "Auto-sync interval (e.g. 30s, 5m)" },
    "auto-sync": { type: "string", description: "Enable auto-sync timer (true/false)" },
    "blob-quota": { type: "string", description: "Local blob cache quota (e.g. 2gb, 500mb, 0 to disable auto-eviction)" },
    url: { type: "string", description: "Peer URL (peer add/rm/enable/disable/sync)" },
    code: { type: "string", description: "One-time pairing code (peer add)" },
    "self-url": { type: "string", description: "This device's reachable URL (peer add, optional)" },
    token: { type: "string", description: "Issued credential token or prefix (device revoke) · Edge owner secret (edge connect)" },
    // Storage peer (peer add --s3): an S3-compatible bucket as store-and-forward.
    s3: { type: "boolean", description: "Add an S3 storage peer (R2/MinIO/S3) instead of pairing" },
    enroll: { type: "string", description: "Enroll code from another device's 「添加设备」/QR — joins that bucket as a secondary device (peer add --s3)" },
    endpoint: { type: "string", description: "S3 endpoint URL (backup connect) · Edge host URL (edge connect)" },
    bucket: { type: "string", description: "S3 bucket name (backup connect)" },
    "access-key": { type: "string", description: "S3 access key id (backup connect / rotate)" },
    "secret-key": { type: "string", description: "S3 secret access key (backup connect / rotate)" },
    prefix: { type: "string", description: "Path prefix within the bucket (backup connect; default metahub)" },
    region: { type: "string", description: "S3 region (backup connect; default auto for R2)" },
    passphrase: { type: "string", description: "E2EE passphrase (backup connect)" },
    "recovery-code": { type: "string", description: "MH1- master-key recovery code — joins without the passphrase (peer add --s3) or supplies K for a passphrase reset (peer rotate)" },
    "new-passphrase": { type: "string", description: "Rewrap the bucket key envelope under this passphrase (peer rotate)" },
    "old-passphrase": { type: "string", description: "Current passphrase, only needed when this device has no cached key (peer rotate)" },
    node: { type: "string", description: "Device node id (device revoke)" },
    refresh: { type: "boolean", description: "Also check bucket presence + publisher heartbeats online (device list)" },
    "provision-r2": { type: "boolean", description: "Create the R2 bucket in your Cloudflare account first, then attach it (backup connect)" },
    "cf-account-id": { type: "string", description: "Cloudflare account id (backup connect --provision-r2)" },
    "cf-api-token": { type: "string", description: "Cloudflare API token with Workers R2 Storage Write; omit to Sign in with Cloudflare (backup connect --provision-r2)" },
    yes: { type: "boolean", description: "Confirm remote resource creation (backup connect --provision-r2 · edge deploy)" },
    // edge deploy/connect (config edge …; same flags as the mh edge aliases)
    "account-id": { type: "string", description: "Cloudflare account id (edge deploy)" },
    "api-token": { type: "string", description: "Cloudflare API token, Workers Scripts + D1 edit (edge deploy)" },
    worker: { type: "string", description: "Worker script name (edge deploy; defaults from this node id)" },
    d1: { type: "string", description: "D1 database name (edge deploy; defaults from this node id)" },
    subdomain: { type: "string", description: "workers.dev subdomain if one must be created (edge deploy)" },
    "purge-retired": { type: "boolean", description: "Also drop previously-retired inbox keys (edge rotate-keys)" },
    allow: { type: "string", description: "Comma-separated shell origins to allow (peer cors)" },
    "cors-origin": { type: "string", description: "Comma-separated shell origins; open bucket CORS after add (peer add --s3, optional)" },
    // citty negates a boolean with --no-<name>, so `--no-encrypt` flips this to
    // false; default true means encryption is on unless explicitly disabled.
    encrypt: {
      type: "boolean",
      default: true,
      description: "E2EE on by default; pass --no-encrypt for plaintext (trusted storage only)",
    },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    const section = typeof args.section === "string" ? args.section : undefined;
    const hasSettingFlag =
      args.host != null ||
      args.port != null ||
      args["sync-interval"] != null ||
      args["auto-sync"] != null ||
      args["blob-quota"] != null;

    if (!section) {
      if (hasSettingFlag) return applySet(db, args);
      if (isTTY()) return wizard(db);
      return showConfig(db); // non-interactive default
    }
    const action = (args.action as string) ?? "list";
    if (section === "show") return showConfig(db);
    if (section === "server") return hasSettingFlag ? applySet(db, args) : showConfig(db);
    if (section === "backup") return backupDispatch(db, action, args);
    if (section === "device") return deviceDispatch(db, action, args);
    if (section === "edge") {
      warn("`mh config edge …` is deprecated; use `mh edge …`");
      return edgeConfigDispatch((args.action as string) ?? "", args);
    }
    // Hidden aliases of the pre-namespace tree — keep working, keep out of help.
    if (section === "set") return applySet(db, args);
    if (section === "peer") return peerDispatch(db, action, args);
    if (section === "grant") return grantDispatch(db, action, args);
    throw new MhError(
      "invalid_input",
      `unknown config section '${section}' (server | device | backup | show)`,
    );
  }),
});
