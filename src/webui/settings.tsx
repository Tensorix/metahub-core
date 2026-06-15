/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import type { S3Config } from "../core/sync/storage.ts";
import { Icon } from "./icons.tsx";
import { getTheme, setTheme, type ThemeChoice } from "./theme.ts";
import { api, currentToken, type Peer, type Grant } from "./api.ts";
import {
  replicaEnabled,
  replicaStatus,
  onReplicaStatus,
  enableReplica,
  disableReplica,
  resetReplica,
  requestSync,
  isNoOrigin,
  clientMode,
  call as replicaCall,
} from "./data/replica.ts";
import type { ReplicaStatus } from "./data/db-worker.ts";
import { cmpVer } from "./version.ts";
import {
  Modal,
  openModal,
  closeModal,
  openMenu,
  MenuItem,
  MenuSep,
  toast,
  confirmDialog,
} from "./ui.tsx";

const THEMES: { value: ThemeChoice; icon: string; name: string; desc: string }[] = [
  { value: "light", icon: "sun", name: "浅色", desc: "始终使用明亮界面" },
  { value: "dark", icon: "moon", name: "深色", desc: "始终使用暗色界面" },
  { value: "system", icon: "monitor", name: "跟随系统", desc: "随操作系统外观自动切换" },
];

/** A titled gray panel that groups related settings blocks. The page is white;
 *  the panel is a subtle gray surface so the white widget cards inside read as
 *  raised insets (macOS System Settings / Notion grouped-list feel). Children
 *  are `.set-block`s, hairline-divided by CSS. */
function SetGroup({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="set-group">
      <div class="set-group-label">{label}</div>
      <div class="set-panel">{children}</div>
    </div>
  );
}

export function SettingsView({ onUpdatePending }: { onUpdatePending?: (p: boolean) => void } = {}) {
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme());

  const pick = (t: ThemeChoice) => {
    setTheme(t);
    setThemeState(t);
  };

  return (
    <div class="set-page">
      <div class="set-title">设置</div>
      <div class="set-sub">个性化你的 Metahub 工作区。</div>

      <SetGroup label="外观">
        <div class="set-block">
          <div class="set-block-head"><span class="set-block-title">颜色主题</span></div>
          <div class="set-block-desc">选择界面的明暗外观。</div>
          <div class="theme-grid">
            {THEMES.map((t) => (
              <button
                key={t.value}
                class={"theme-card" + (theme === t.value ? " sel" : "")}
                aria-pressed={theme === t.value}
                onClick={() => pick(t.value)}
              >
                <span class="tc-check"><Icon name="check" /></span>
                <span class="tc-ico"><Icon name={t.icon} /></span>
                <span class="tc-name">{t.name}</span>
                <span class="tc-desc">{t.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </SetGroup>

      {typeof window !== "undefined" && window.metahubDesktop?.quicknote && (
        <SetGroup label="快速笔记"><QuickNotesSettings /></SetGroup>
      )}

      {/* One model, two axes (doc 19): how THIS device holds data (window/replica)
          and where the WHOLE workspace syncs (server + bucket backend). */}
      <SetGroup label="同步">
        <SyncTopology />
        <OfflineReplica />
        <SyncStorage />
      </SetGroup>

      {/* HTTP pairing + issued grants only make sense against a server (origin). */}
      {!isNoOrigin() && (
        <SetGroup label="设备与授权">
          <SyncDevices />
          <IssuedGrants />
        </SetGroup>
      )}

      <VersionFooter onUpdatePending={onUpdatePending} />
    </div>
  );
}

// ---- offline replica (browser as a sync node) ------------------------------

/** Why the replica can't run here, or null when it can. Shown in the section
 *  instead of hiding it — a silently missing switch is undebuggable (the
 *  common case: opening the server over plain http from a phone, which is not
 *  a secure context, so OPFS and service workers don't exist at all). */
function replicaUnsupportedReason(): string | null {
  if (typeof Worker === "undefined" || typeof navigator === "undefined") {
    return "此浏览器不支持 Web Worker。";
  }
  if (!window.isSecureContext) {
    return "需要 HTTPS（安全上下文）。当前是 http:// 访问，浏览器不开放离线所需的 OPFS 与 Service Worker——给服务器配置 TLS（--tls-cert/--tls-key，或 Caddy / Tailscale Serve 反代；iPhone 需要受信任的证书），或在本机用 localhost 访问。";
  }
  if (!navigator.storage?.getDirectory) {
    return "此浏览器不支持 OPFS 本地存储（需要 Safari 17+ / Chrome / Firefox 较新版本）。";
  }
  return null;
}

// ---- sync overview: a small topology map -----------------------------------
// "How is THIS device wired?" answered at a glance instead of in prose. Chips
// for this device, the server (origin mode), and the cloud bucket, joined by
// HTTP / 桶 links (the live one solid, the idle one dashed). The publisher — who
// mirrors the whole hub into the bucket — is named on the bucket chip. See
// docs/impl-context/19-client-topology.

function SyncTopology() {
  const isElectron = typeof window !== "undefined" && !!window.metahubDesktop;
  const [, bump] = useState(0);
  // Re-render on replica state changes; the two axes come from clientMode().
  useEffect(() => onReplicaStatus(() => bump((n) => n + 1)), []);
  const mode = clientMode();
  const noOrigin = mode.dataHome === "local";
  const [hasBucket, setHasBucket] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => {
      const p: Promise<unknown[]> = noOrigin
        ? replicaEnabled()
          ? replicaCall<unknown[]>("listStoragePeers")
          : Promise.resolve([])
        : api.listServerS3Peers().catch(() => []);
      p.then((rows) => live && setHasBucket(rows.length > 0)).catch(() => {});
    };
    load();
    const off = onReplicaStatus(load);
    return () => {
      live = false;
      off();
    };
  }, [noOrigin]);

  const replica = mode.hold === "replica";

  return (
    <div class="set-block">
      <div class="set-block-head"><span class="set-block-title">概览</span></div>
      <div class="set-block-desc">
        这台设备怎么拿数据(窗口 / 副本),以及整个工作区在设备间怎么同步(服务器 + 存储桶后端)。
      </div>
      <div class="sync-topo">
        <span class="sync-node self">
          <span class="sync-node-top">
            <Icon name={replica ? "database" : "eye"} cls="ico sm" />
            本设备
          </span>
          <span class="sync-node-role">{replica ? "副本 · 可离线" : "窗口 · 在线"}</span>
        </span>
        {!noOrigin && (
          <>
            <span class="sync-link active" data-label="HTTP" />
            <span class="sync-node">
              <span class="sync-node-top">
                <Icon name="globe" cls="ico sm" />
                {isElectron ? "内置服务" : "服务器"}
              </span>
              <span class="sync-node-role">{hasBucket ? "数据家 · 发布者" : "数据家"}</span>
            </span>
          </>
        )}
        {hasBucket && (
          <>
            <span class={"sync-link " + (noOrigin ? "active" : "idle")} data-label="桶" />
            <span class="sync-node">
              <span class="sync-node-top">
                <Icon name="cube" cls="ico sm" />
                存储桶
              </span>
              <span class="sync-node-role">发布:{noOrigin ? "本机" : "服务器"}</span>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The settings switch that turns THIS browser into a CRDT sync node: pairs it
 * with the server (self-service — the page already holds the master token),
 * hydrates a full local OPFS replica, and from then on reads/writes go local
 * with background /sync. Per-device choice; unpaired browsers stay plain
 * online clients. The issued grant shows up under 已授权设备 and can be
 * revoked server-side at any time.
 */
function OfflineReplica() {
  const unsupported = replicaUnsupportedReason();
  const [enabled, setEnabled] = useState(replicaEnabled());
  const [st, setSt] = useState<ReplicaStatus>(replicaStatus());
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<string | null>(null);

  useEffect(() => onReplicaStatus((s) => setSt({ ...s })), []);

  // Origin storage footprint (OPFS replica + SW caches), refreshed per sync.
  useEffect(() => {
    if (!enabled || !navigator.storage?.estimate) return;
    let live = true;
    const refresh = () =>
      navigator.storage.estimate().then((e) => {
        if (live && e.usage != null) setUsage((e.usage / 1024 / 1024).toFixed(1));
      });
    void refresh();
    const off = onReplicaStatus(() => void refresh());
    return () => {
      live = false;
      off();
    };
  }, [enabled]);

  const reset = async () => {
    const ok = await confirmDialog({
      title: "重置本地副本",
      message:
        "将删除此浏览器里的全部本地数据（服务器数据不受影响），并停用离线副本。未同步的本地修改会丢失——建议先「立即同步」。",
      confirmLabel: "删除并重置",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await resetReplica();
      setEnabled(false);
      toast("本地副本已重置");
    } catch (e) {
      toast(`重置失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    setBusy(true);
    try {
      await enableReplica();
      setEnabled(true);
      toast("离线副本已启用，正在下载数据…");
    } catch (e) {
      toast(`启用失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    const ok = await confirmDialog({
      title: "停用离线副本",
      message:
        "此浏览器将恢复纯在线模式。已下载的本地数据保留在浏览器里，重新启用后从断点续传。",
      confirmLabel: "停用",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await disableReplica();
      setEnabled(false);
      toast("已停用离线副本");
    } finally {
      setBusy(false);
    }
  };

  const statusLine = () => {
    if (!enabled) return "未启用 — 此浏览器为纯在线客户端，断网不可用。";
    if (st.state === "error") return `副本异常（已自动回退在线模式）：${st.error ?? "未知错误"}`;
    if (st.state === "hydrating") return `正在下载数据… 已接收 ${st.hydrated ?? 0} 条变更`;
    if (st.lastSync) {
      const t = fmtTime(st.lastSync.at);
      return st.lastSync.ok
        ? `本地优先已生效 · 上次同步 ${t}（推送 ${st.lastSync.pushed} / 拉取 ${st.lastSync.pulled}）`
        : `上次同步失败（${t}）：${st.lastSync.error ?? ""} — 本地读写不受影响，恢复网络后自动重试`;
    }
    return "等待首次同步…";
  };

  if (unsupported) {
    return (
      <div class="set-block">
        <div class="set-block-head"><span class="set-block-title">这台设备</span></div>
        <div class="set-block-desc">当前为窗口模式:在线读写,不在本机存储。</div>
        <div class="peer-sub">⚠ 无法保留离线副本:{unsupported}</div>
      </div>
    );
  }

  return (
    <div class="set-block">
      <div class="set-block-head"><span class="set-block-title">这台设备</span></div>
      <div class="set-block-desc">
        选择这台设备怎么拿数据。启用副本即与服务器配对,凭据可在「设备与授权 · 已授权设备」中单独吊销。
      </div>
      <div class="theme-grid sync-holds">
        <button
          class={"theme-card" + (!enabled ? " sel" : "")}
          aria-pressed={!enabled}
          disabled={busy}
          onClick={() => enabled && disable()}
        >
          <span class="tc-check"><Icon name="check" /></span>
          <span class="tc-ico"><Icon name="eye" /></span>
          <span class="tc-name">窗口</span>
          <span class="tc-desc">在线读 · 不在本机存 · 秒开</span>
        </button>
        <button
          class={"theme-card" + (enabled ? " sel" : "")}
          aria-pressed={enabled}
          disabled={busy}
          onClick={() => !enabled && enable()}
        >
          <span class="tc-check"><Icon name="check" /></span>
          <span class="tc-ico"><Icon name="database" /></span>
          <span class="tc-name">副本</span>
          <span class="tc-desc">{busy && !enabled ? "启用中…" : "存一份完整数据 · 弱网/离线可读写"}</span>
        </button>
      </div>
      {enabled && (
        <div class="peer-actions" style={{ marginTop: 12 }}>
          <button class="btn btn-secondary" disabled={busy} onClick={() => requestSync()}>
            <Icon name="share" cls="ico sm" /> 立即同步
          </button>
          <button class="btn btn-ghost" disabled={busy} onClick={reset}>
            重置本地副本
          </button>
        </div>
      )}
      <div class="peer-sub" style="margin-top:8px">
        {statusLine()}
        {enabled && st.node ? ` · 节点 ${st.node}` : ""}
        {enabled && usage ? ` · 本地占用 ${usage} MB` : ""}
      </div>
    </div>
  );
}

// ---- sync storage (this browser ⇄ an S3/R2 bucket) ------------------------

interface StoragePeerView {
  url: string;
  label: string | null;
  enabled: boolean;
  status: string | null;
  error: string | null;
  lastSyncAt: number | null;
}

/**
 * Point THIS browser's local replica at an S3-compatible bucket (R2/MinIO/S3)
 * used as dumb store-and-forward — so it syncs with your other devices without
 * any of them running a public server, and even when they're offline. The
 * bucket peer lives in this browser's replica DB and is driven by the worker's
 * sync loop, so it requires the offline replica to be enabled first.
 */
function SyncStorage() {
  // Two modes (doc 19): with a server (origin) the bucket is configured ON the
  // server — the data home + publisher — via /api/peer/s3; without one
  // (no-origin) it lives in this browser's local replica, which is itself the
  // home. So "add a bucket" targets the node that actually holds the hub.
  const noOrigin = isNoOrigin();
  const [enabled, setEnabled] = useState(replicaEnabled());
  const [peers, setPeers] = useState<StoragePeerView[] | null>(null);

  useEffect(() => onReplicaStatus(() => setEnabled(replicaEnabled())), []);

  const reload = () => {
    if (noOrigin) {
      if (!replicaEnabled()) {
        setPeers(null);
        return;
      }
      replicaCall<StoragePeerView[]>("listStoragePeers")
        .then(setPeers)
        .catch((e) => toast(`加载失败：${(e as Error).message}`));
    } else {
      api
        .listServerS3Peers()
        .then((rows) =>
          setPeers(
            rows.map((r) => ({
              url: r.url,
              label: r.label,
              enabled: r.enabled === 1,
              status: r.status,
              error: r.error,
              lastSyncAt: r.lastSyncAt,
            })),
          ),
        )
        .catch((e) => toast(`加载失败：${(e as Error).message}`));
    }
  };

  useEffect(() => {
    reload();
  }, [enabled]);

  const add = () =>
    openModal(
      <AddStorageModal
        toServer={!noOrigin}
        alsoReplica={!noOrigin && enabled}
        onDone={() => {
          closeModal();
          reload();
        }}
      />,
    );

  const syncNow = async () => {
    try {
      if (noOrigin) await replicaCall("sync");
      else {
        await Promise.all((peers ?? []).map((p) => api.syncPeer(p.url)));
        // A replica behind the server also peers the bucket directly — flush it too.
        if (enabled) await replicaCall("sync").catch(() => {});
      }
      toast("已触发同步");
      reload();
    } catch (e) {
      toast(`同步失败：${(e as Error).message}`);
    }
  };

  const remove = async (p: StoragePeerView) => {
    const ok = await confirmDialog({
      title: "移除存储桶后端",
      message: `确定移除 ${p.label || p.url}？将停止与该存储桶同步（桶内数据不受影响）。`,
      confirmLabel: "移除",
      danger: true,
    });
    if (!ok) return;
    if (noOrigin) {
      await replicaCall("removeStorageReplica", p.url).catch((e) => toast((e as Error).message));
    } else {
      await api.removePeer(p.url).catch((e) => toast((e as Error).message));
      // Drop the replica's own copy of the bucket peer too, if it attached one.
      if (enabled) await replicaCall("removeStorageReplica", p.url).catch(() => {});
    }
    reload();
  };

  // Show a QR a phone scans to enroll the same bucket (no manual typing): the
  // link carries the bucket credentials but never the passphrase — the phone
  // types that. The shell base URL is configurable, never hardcoded.
  const openPhone = async (p: StoragePeerView) => {
    try {
      const config = await replicaCall<S3Config | null>("storagePeerConfig", p.url);
      if (!config) return toast("找不到该存储的配置");
      openModal(<QrModal config={config} />);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  // Where the bucket attaches — the one fact that used to be buried in morphing
  // prose. origin → the server (data home + publisher); no-origin → this device.
  const mountTarget = noOrigin ? "本设备" : "服务器";
  const rowTag = noOrigin ? "本机发布" : "服务器发布";

  return (
    <div class="set-block">
      <div class="set-block-head"><span class="set-block-title">工作区后端</span></div>
      <div class="set-block-desc">整个工作区在哪些后端落盘、在设备间怎么同步。</div>

      {!noOrigin && (
        <div class="set-fact">
          <Icon name="globe" cls="ico sm" />
          <span>数据落在<b>服务器</b>(数据家);它作为发布者把整库镜像进存储桶。</span>
        </div>
      )}

      <div class="set-subhead">
        <span class="set-subhead-title">存储桶后端 <span class="sh-dim">· 云端中转</span></span>
        <span class="set-block-spacer" />
        <span class="mount-badge"><span class="mb-k">挂载到</span> ▸ {mountTarget}</span>
      </div>
      <div class="set-block-desc">
        S3 兼容存储桶做多设备中转——无需公网 IP、对方离线也能同步,上传前端到端加密。
        {!noOrigin && enabled ? "本机副本也接入同一个桶,服务器离线/在外时经桶兜底。" : ""}
      </div>

      {noOrigin && !enabled ? (
        <div class="peer-sub">⚠ 请先在上方把「这台设备」设为「副本」,再添加存储桶。</div>
      ) : (
        <>
          <div class="peer-actions">
            <button class="btn btn-primary" onClick={add}>
              <Icon name="plus" cls="ico sm" /> 添加存储桶
            </button>
            {peers && peers.length > 0 && (
              <button class="btn btn-secondary" onClick={syncNow}>
                <Icon name="share" cls="ico sm" /> 立即同步
              </button>
            )}
          </div>

          <div class="peer-list flush">
            {peers == null ? (
              <div class="muted">加载中…</div>
            ) : peers.length === 0 ? (
              <div class="muted">还没接入存储桶——加一个,多设备就能免公网 IP 互通。</div>
            ) : (
              peers.map((p) => (
                <div key={p.url} class="peer-row">
                  <span class={"peer-dot" + (p.enabled ? (p.status === "error" ? " err" : " on") : " off")} />
                  <div class="peer-main">
                    <div class="peer-url">{p.label || p.url}</div>
                    <div class="peer-sub">
                      最近同步 {fmtTime(p.lastSyncAt)}
                      {p.status === "error" && p.error ? ` · 错误:${p.error}` : ""}
                    </div>
                  </div>
                  <span class="peer-tag pub">{rowTag}</span>
                  {noOrigin && (
                    <button class="btn btn-ghost peer-menu" title="在手机上打开" onClick={() => openPhone(p)}>
                      <Icon name="share" cls="ico sm" />
                    </button>
                  )}
                  <button class="btn btn-ghost peer-menu" title="移除" onClick={() => remove(p)}>
                    <Icon name="trash" cls="ico sm" />
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---- "open on your phone" enroll QR ----------------------------------------

const SHELL_BASE_KEY = "mh_shell_base";

/** Build the deep link a phone opens to enroll this bucket. Carries the bucket
 *  credentials (so the phone can connect) but NOT the passphrase or master key —
 *  the phone types the passphrase. `shellBase` is the static-shell domain
 *  (configurable; defaults to the current origin for LAN/Tailscale setups). */
function enrollUrl(shellBase: string, c: S3Config): string {
  const slim = {
    endpoint: c.endpoint,
    region: c.region,
    bucket: c.bucket,
    prefix: c.prefix,
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    encrypt: c.encrypt,
    virtualHostedStyle: c.virtualHostedStyle,
  };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(slim))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const base = (shellBase || location.origin).replace(/\/+$/, "");
  return `${base}/#enroll=${b64}`;
}

function QrModal({ config }: { config: S3Config }) {
  const [shellBase, setShellBase] = useState(() => {
    try {
      return localStorage.getItem(SHELL_BASE_KEY) || location.origin;
    } catch {
      return location.origin;
    }
  });
  const url = enrollUrl(shellBase, config);
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });

  const onBase = (v: string) => {
    setShellBase(v);
    try {
      v ? localStorage.setItem(SHELL_BASE_KEY, v) : localStorage.removeItem(SHELL_BASE_KEY);
    } catch {
      /* private mode */
    }
  };

  return (
    <Modal
      title="在手机上打开"
      sub="手机相机扫码打开 PWA,输入加密口令即可同步。二维码只含桶访问凭据,不含口令。"
      footer={<button class="btn btn-primary" onClick={closeModal}>完成</button>}
    >
      <div class="qr-box" dangerouslySetInnerHTML={{ __html: svg }} />
      <div class="field-label">壳地址（手机访问的静态站点域名；留空用当前地址）</div>
      <input
        class="text-input"
        placeholder={location.origin}
        value={shellBase}
        onInput={(e) => onBase((e.target as HTMLInputElement).value)}
      />
      <button
        class="btn btn-secondary"
        style={{ width: "100%", marginTop: 12 }}
        onClick={() => {
          navigator.clipboard?.writeText(url);
          toast("已复制链接");
        }}
      >
        <Icon name="copy" cls="ico sm" /> 复制链接
      </button>
      <div class="peer-sub" style="margin-top:8px">⚠ 二维码含桶访问密钥,请勿公开分享。</div>
    </Modal>
  );
}

/** Heuristic: a fetch that failed at the CORS/network layer (opaque TypeError)
 *  rather than an HTTP error from S3. The bucket almost certainly lacks a CORS
 *  rule for this origin — the one setup step a phone needs. */
function looksLikeCors(message: string): boolean {
  return /failed to fetch|load failed|networkerror|cors/i.test(message);
}

// ---- origin "open on your phone": a `<server>/?token=…` QR -----------------
// The mirror of the no-origin enroll QR, for the server (origin) case: the phone
// scans it to open AND log into the server in one step (auth.ts accepts ?token),
// no typing. The token is a bearer secret, so the QR is treated as sensitive.

const SERVER_BASE_KEY = "mh_server_base";

function originEnrollUrl(base: string, token: string | null): string {
  const b = (base || location.origin).replace(/\/+$/, "");
  return token ? `${b}/?token=${encodeURIComponent(token)}` : b;
}

function OriginQrModal() {
  const [base, setBase] = useState(() => {
    try {
      return localStorage.getItem(SERVER_BASE_KEY) || location.origin;
    } catch {
      return location.origin;
    }
  });
  const url = originEnrollUrl(base, currentToken());
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });

  const onBase = (v: string) => {
    setBase(v);
    try {
      v ? localStorage.setItem(SERVER_BASE_KEY, v) : localStorage.removeItem(SERVER_BASE_KEY);
    } catch {
      /* private mode */
    }
  };

  return (
    <Modal
      title="在手机上打开"
      sub="手机相机扫码即可打开并登录本服务器（无需手输访问令牌）。"
      footer={<button class="btn btn-primary" onClick={closeModal}>完成</button>}
    >
      <div class="qr-box" dangerouslySetInnerHTML={{ __html: svg }} />
      <div class="field-label">服务器地址（手机访问的域名；留空用当前地址）</div>
      <input
        class="text-input"
        placeholder={location.origin}
        value={base}
        onInput={(e) => onBase((e.target as HTMLInputElement).value)}
      />
      <button
        class="btn btn-secondary"
        style={{ width: "100%", marginTop: 12 }}
        onClick={() => {
          navigator.clipboard?.writeText(url);
          toast("已复制链接");
        }}
      >
        <Icon name="copy" cls="ico sm" /> 复制链接
      </button>
      <div class="peer-sub" style="margin-top:8px">⚠ 二维码含访问令牌，请勿公开分享。</div>
    </Modal>
  );
}

function AddStorageModal({
  onDone,
  toServer,
  alsoReplica,
}: {
  onDone: () => void;
  toServer?: boolean;
  alsoReplica?: boolean;
}) {
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("auto");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [prefix, setPrefix] = useState("metahub");
  const [encrypt, setEncrypt] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!endpoint.trim() || !bucket.trim() || !accessKey.trim() || !secretKey.trim()) {
      toast("endpoint、bucket、access key、secret key 必填");
      return;
    }
    if (encrypt && !passphrase) {
      toast("加密口令必填（或关闭加密）");
      return;
    }
    setBusy(true);
    try {
      const config = {
        endpoint: endpoint.trim(),
        region: region.trim() || "auto",
        bucket: bucket.trim(),
        prefix: prefix.trim() || "metahub",
        accessKeyId: accessKey.trim(),
        secretAccessKey: secretKey.trim(),
        encrypt,
      };
      // origin → attach to the server (data home + publisher), opening bucket CORS
      // for this browser's origin; no-origin → this browser's local replica (which
      // is the home). When origin AND this browser keeps an offline replica, ALSO
      // attach the bucket here as a non-publisher (publish:false) so the replica
      // can sync via the bucket when the server is unreachable (away-sync). Server
      // first, so CORS is open before the browser hits the bucket directly.
      let url: string;
      if (toServer) {
        ({ url } = await api.addServerS3Peer({ ...config, passphrase, corsOrigins: [location.origin] }));
        if (alsoReplica) {
          ({ url } = await replicaCall<{ url: string }>(
            "addStorageReplica",
            { ...config, publish: false },
            passphrase,
          ));
        }
      } else {
        ({ url } = await replicaCall<{ url: string }>("addStorageReplica", config, passphrase));
      }
      toast(`已接入存储桶 ${url}`);
      onDone();
    } catch (e) {
      const msg = (e as Error).message;
      toast(
        looksLikeCors(msg)
          ? "连接被浏览器拦截：请给存储桶配置 CORS，允许此源的 GET/PUT/HEAD/DELETE（R2 控制台一条规则即可）。"
          : `添加失败：${msg}`,
      );
      setBusy(false);
    }
  };

  return (
    <Modal
      title="添加同步存储"
      sub="填入 S3 兼容存储桶的连接信息（推荐 Cloudflare R2，免费 10GB）。新桶会自动初始化；已有桶请使用相同的加密口令。"
      footer={
        <>
          <button class="btn btn-secondary" onClick={closeModal} disabled={busy}>取消</button>
          <button class="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "连接中…" : "添加"}
          </button>
        </>
      }
    >
      <div class="field-label">Endpoint</div>
      <input
        class="text-input"
        autofocus
        placeholder="https://<account>.r2.cloudflarestorage.com"
        value={endpoint}
        onInput={(e) => setEndpoint((e.target as HTMLInputElement).value)}
      />
      <div class="field-label">Bucket</div>
      <input
        class="text-input"
        placeholder="my-metahub"
        value={bucket}
        onInput={(e) => setBucket((e.target as HTMLInputElement).value)}
      />
      <div class="field-label">Region</div>
      <input
        class="text-input"
        placeholder="auto"
        value={region}
        onInput={(e) => setRegion((e.target as HTMLInputElement).value)}
      />
      <div class="field-label">Access Key ID</div>
      <input
        class="text-input"
        value={accessKey}
        onInput={(e) => setAccessKey((e.target as HTMLInputElement).value)}
      />
      <div class="field-label">Secret Access Key</div>
      <input
        class="text-input"
        type="password"
        value={secretKey}
        onInput={(e) => setSecretKey((e.target as HTMLInputElement).value)}
      />
      <div class="field-label">路径前缀</div>
      <input
        class="text-input"
        placeholder="metahub"
        value={prefix}
        onInput={(e) => setPrefix((e.target as HTMLInputElement).value)}
      />
      <label class="set-check-row" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt((e.target as HTMLInputElement).checked)} />
        <span>端到端加密（强烈建议；关闭后段文件为明文，仅限完全信任的存储）</span>
      </label>
      {encrypt && (
        <>
          <div class="field-label">加密口令</div>
          <input
            class="text-input"
            type="password"
            placeholder="新桶将以此创建；已有桶需输入相同口令"
            value={passphrase}
            onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </>
      )}
    </Modal>
  );
}

// ---- version footer (+ core update, desktop only) -------------------------

type UpdateState = "idle" | "checking" | "available" | "downloading" | "staged" | "error";

/**
 * The version line in the settings footer, doubling as the (desktop-only) core
 * update entry. Quiet by design — a mono version line with an inline update
 * affordance, not a card. Driven by three versions: R = running (sidecar's
 * /api/version), I = installed/staged on disk (next launch), L = latest on
 * GitHub (manual check). `I > R` means an update is already downloaded and only
 * waiting for a restart — surfaced with no network call, since the app's startup
 * auto-updater may have staged it silently. In the plain browser (CLI server)
 * there is no `metahubDesktop` bridge, so only the core version shows.
 */
function VersionFooter({ onUpdatePending }: { onUpdatePending?: (p: boolean) => void }) {
  const cu = typeof window !== "undefined" ? window.metahubDesktop?.coreUpdate : undefined;
  const [appVer, setAppVer] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null); // R, also the "Core" version shown
  const [installed, setInstalled] = useState<string | null>(null); // I (desktop only)
  const [latest, setLatest] = useState<string | null>(null); // L
  const [state, setState] = useState<UpdateState>("idle");
  const [errMsg, setErrMsg] = useState("");

  useEffect(() => {
    api.version().then((v) => setRunning(v.version)).catch(() => setRunning(null));
    const d = typeof window !== "undefined" ? window.metahubDesktop : undefined;
    d?.appVersion?.().then(setAppVer).catch(() => setAppVer(null));
    cu?.installedVersion().then(setInstalled).catch(() => setInstalled(null));
  }, []);

  // Once running (R) and installed (I) have both landed, a staged update (I > R)
  // means one is downloaded and only waiting for a restart — surfaced with no
  // network call (the startup auto-updater may have staged it silently).
  useEffect(() => {
    if (state === "idle" && running && installed && cmpVer(installed, running) > 0) {
      setState("staged");
      onUpdatePending?.(true);
    }
  }, [running, installed]);

  /** Highest of running/installed — the floor a GitHub release must beat to count as new. */
  const floor = (): string | null => {
    if (running && installed) return cmpVer(installed, running) > 0 ? installed : running;
    return installed ?? running;
  };
  const pendingRestart = () => !!(running && installed && cmpVer(installed, running) > 0);

  const check = async () => {
    setState("checking");
    setErrMsg("");
    try {
      const { latest: l } = await cu!.check();
      if (!l) {
        // null means the GitHub API call failed (offline / rate-limited), not
        // "no update" — saying 已是最新 here would mask the failure.
        setErrMsg("无法获取最新版本（网络不可用或 GitHub API 受限）");
        setState("error");
        return;
      }
      const f = floor();
      if (!f || cmpVer(l, f) > 0) {
        setLatest(l);
        setState("available");
        onUpdatePending?.(true);
      } else {
        toast("已是最新版本");
        setState(pendingRestart() ? "staged" : "idle");
      }
    } catch (e) {
      setErrMsg((e as Error).message);
      setState("error");
    }
  };

  const download = async () => {
    setState("downloading");
    setErrMsg("");
    try {
      const v = await cu!.download();
      if (v) {
        setInstalled(v);
        setState("staged");
        onUpdatePending?.(true);
        toast(`已下载 v${v}`);
      } else {
        // Nothing newer than what's already staged (e.g. double-click).
        toast("已是最新版本");
        setState(pendingRestart() ? "staged" : "idle");
      }
    } catch (e) {
      setErrMsg((e as Error).message);
      setState("error");
    }
  };

  // The inline update affordance — a quiet text link, with the page's only
  // accent dot when something is actionable. Desktop only.
  let update: ComponentChildren = null;
  if (cu) {
    switch (state) {
      case "checking":
        update = <span class="ver-act" aria-disabled="true">检查中…</span>;
        break;
      case "downloading":
        update = <span class="ver-act" aria-disabled="true">下载中…</span>;
        break;
      case "available":
        update = (
          <span class="ver-up">
            <span class="ver-dot pulse" />
            <span>新版本 <span class="ver-num">{latest}</span></span>
            <button class="ver-act accent" onClick={download} title={`下载并更新到 v${latest}`}>下载</button>
          </span>
        );
        break;
      case "staged":
        update = (
          <span class="ver-up">
            <span class="ver-dot pulse" />
            <span><span class="ver-num">{installed}</span> 待重启</span>
            <button class="ver-act accent" onClick={() => void cu.restart()} title={`重启应用以更新到 v${installed}`}>重启</button>
          </span>
        );
        break;
      case "error":
        update = (
          <span class="ver-up err">
            <span class="ver-msg">检查失败</span>
            <button class="ver-act" onClick={check} title={errMsg || "重试"}>重试</button>
          </span>
        );
        break;
      default:
        update = <button class="ver-act" onClick={check}>检查更新</button>;
    }
  }

  return (
    <div class="set-footer">
      {appVer && <span>App <span class="ver-num">{appVer}</span></span>}
      {appVer && running && <span class="set-footer-sep">·</span>}
      {running && <span>Core <span class="ver-num">{running}</span></span>}
      {update && (running || appVer) && <span class="set-footer-sep">·</span>}
      {update}
    </div>
  );
}

// ---- quick notes (desktop only) -------------------------------------------

const DEFAULT_SHORTCUT = "CommandOrControl+Shift+Space";

/** Build an Electron accelerator from a keydown, or null for an invalid combo. */
function toAccelerator(e: KeyboardEvent): string | null {
  if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return null; // modifier alone
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.startsWith("Arrow")) key = key.slice(5);
  else if (key.length === 1) key = key.toUpperCase();
  if (parts.length === 0) return null; // require at least one modifier
  parts.push(key);
  return parts.join("+");
}

/** Show an accelerator the way users read it, per platform. */
function prettyShortcut(accel: string): string {
  const mac = typeof window !== "undefined" && window.metahubDesktop?.platform === "darwin";
  return accel
    .replace("CommandOrControl", mac ? "⌘" : "Ctrl")
    .replace("Alt", mac ? "⌥" : "Alt")
    .replace("Shift", mac ? "⇧" : "Shift")
    .split("+")
    .join(mac ? " " : "+");
}

function QuickNotesSettings() {
  const qn = window.metahubDesktop!.quicknote!;
  const [shortcut, setShortcut] = useState<string>(DEFAULT_SHORTCUT);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    qn.getSettings()
      .then((s) => {
        setShortcut(s.shortcut);
        setAlwaysOnTop(s.alwaysOnTop);
      })
      .catch((e) => toast(`加载失败：${(e as Error).message}`));
  }, []);

  const applyShortcut = async (accel: string) => {
    try {
      const s = await qn.setShortcut(accel);
      setShortcut(s.shortcut);
      toast(`快捷键已设为 ${prettyShortcut(s.shortcut)}`);
    } catch (e) {
      toast(`设置失败：${(e as Error).message}`);
    }
  };

  const onCaptureKey = (e: KeyboardEvent) => {
    e.preventDefault();
    if (e.key === "Escape") {
      setCapturing(false);
      return;
    }
    const accel = toAccelerator(e);
    if (!accel) return; // wait for a full modifier+key combo
    setCapturing(false);
    void applyShortcut(accel);
  };

  const toggleTop = async () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    try {
      setAlwaysOnTop(await qn.setAlwaysOnTop(next));
    } catch (e) {
      setAlwaysOnTop(!next);
      toast(`设置失败：${(e as Error).message}`);
    }
  };

  return (
    <div class="set-block">
      <div class="set-block-desc">
        用全局快捷键随时唤起小窗记录想法。小窗也可从菜单栏图标打开。
      </div>

      <div class="qn-set-row">
        <div class="qn-set-main">
          <div class="qn-set-name">唤起快捷键</div>
          <div class="qn-set-desc">点击下方按钮，然后按下你想用的组合键。</div>
        </div>
        <button
          class={"btn btn-secondary qn-shortcut" + (capturing ? " capturing" : "")}
          onClick={() => setCapturing(true)}
          onBlur={() => setCapturing(false)}
          onKeyDown={capturing ? onCaptureKey : undefined}
        >
          {capturing ? "按下组合键…" : prettyShortcut(shortcut)}
        </button>
        {shortcut !== DEFAULT_SHORTCUT && (
          <button class="btn btn-ghost" title="重置默认" onClick={() => void applyShortcut(DEFAULT_SHORTCUT)}>
            重置
          </button>
        )}
      </div>

      <div class="qn-set-row">
        <div class="qn-set-main">
          <div class="qn-set-name">默认始终置顶</div>
          <div class="qn-set-desc">小窗浮在其他窗口之上；也可在小窗内用 📌 按钮切换。</div>
        </div>
        <button
          class={"btn " + (alwaysOnTop ? "btn-primary" : "btn-secondary")}
          aria-pressed={alwaysOnTop}
          onClick={() => void toggleTop()}
        >
          {alwaysOnTop ? "已开启" : "已关闭"}
        </button>
      </div>
    </div>
  );
}

// ---- sync devices ----------------------------------------------------------

function fmtTime(ms: number | null): string {
  if (!ms) return "从未";
  return new Date(ms).toLocaleString();
}

function SyncDevices() {
  const [peers, setPeers] = useState<Peer[] | null>(null);

  const reload = () =>
    api
      .listPeers()
      .then(setPeers)
      .catch((e) => toast(`加载失败：${e.message}`));

  useEffect(() => {
    reload();
  }, []);

  const showCode = async () => {
    try {
      const c = await api.newPairingCode();
      openModal(<PairingCodeModal code={c.code} exp={c.exp} />);
    } catch (e) {
      toast(`生成失败：${(e as Error).message}`);
    }
  };

  const addPeer = () =>
    openModal(
      <AddPeerModal
        onDone={() => {
          closeModal();
          reload();
        }}
      />,
    );

  const syncNow = async (p: Peer) => {
    try {
      const r = await api.syncPeer(p.url);
      toast(r.ok ? `已同步：推送 ${r.pushed}，拉取 ${r.pulled}` : `同步失败：${r.error}`);
      reload();
    } catch (e) {
      toast(`同步失败：${(e as Error).message}`);
    }
  };

  const toggle = async (p: Peer) => {
    await api.updatePeer(p.url, { enabled: !p.enabled }).catch((e) => toast(e.message));
    reload();
  };

  const remove = async (p: Peer) => {
    const ok = await confirmDialog({
      title: "移除同步设备",
      message: `确定移除 ${p.url}？将停止与该设备的数据同步。`,
      confirmLabel: "移除",
      danger: true,
    });
    if (!ok) return;
    await api.removePeer(p.url).catch((e) => toast(e.message));
    reload();
  };

  const menu = (e: MouseEvent, p: Peer) =>
    openMenu(e, (close) => (
      <>
        <MenuItem icon="share" label="立即同步" onClick={() => { close(); syncNow(p); }} />
        <MenuItem
          icon={p.enabled ? "eyeOff" : "check"}
          label={p.enabled ? "禁用" : "启用"}
          onClick={() => { close(); toggle(p); }}
        />
        <MenuSep />
        <MenuItem icon="trash" label="移除" danger onClick={() => { close(); remove(p); }} />
      </>
    ));

  return (
    <div class="set-block">
      <div class="set-block-head"><span class="set-block-title">同步设备</span></div>
      <div class="set-block-desc">
        与其他设备配对,自动双向同步数据。在对方设备生成配对码,然后在此添加。
      </div>

      <div class="peer-actions">
        <button class="btn btn-primary" onClick={addPeer}>
          <Icon name="plus" cls="ico sm" /> 添加设备
        </button>
        <button class="btn btn-secondary" onClick={() => openModal(<OriginQrModal />)}>
          <Icon name="share" cls="ico sm" /> 在手机上打开
        </button>
        <button class="btn btn-ghost" onClick={showCode}>
          <Icon name="link" cls="ico sm" /> 生成配对码
        </button>
      </div>

      <div class="peer-list flush">
        {peers == null ? (
          <div class="muted">加载中…</div>
        ) : peers.length === 0 ? (
          <div class="muted">还没有配对的设备。</div>
        ) : (
          peers.map((p) => (
            <div key={p.url} class="peer-row">
              <span class={"peer-dot" + (p.enabled ? (p.last_status === "error" ? " err" : " on") : " off")} />
              <div class="peer-main">
                <div class="peer-url">{p.label || p.url}</div>
                <div class="peer-sub">
                  {p.enabled ? "已启用" : "已禁用"} · 最近同步 {fmtTime(p.last_sync_at)}
                  {p.last_status === "error" && p.last_error ? ` · 错误：${p.last_error}` : ""}
                </div>
              </div>
              <button class="btn btn-ghost peer-menu" onClick={(e) => menu(e as unknown as MouseEvent, p)}>
                <Icon name="dots" cls="ico sm" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function IssuedGrants() {
  const [grants, setGrants] = useState<Grant[] | null>(null);

  const reload = () =>
    api
      .listGrants()
      .then(setGrants)
      .catch((e) => toast(`加载失败：${e.message}`));

  useEffect(() => {
    reload();
  }, []);

  const revoke = async (g: Grant) => {
    const ok = await confirmDialog({
      title: "吊销凭据",
      message: `吊销后，持有此凭据的设备${g.peer_url ? `（${g.peer_url}）` : ""}将无法再同步进本机。`,
      confirmLabel: "吊销",
      danger: true,
    });
    if (!ok) return;
    await api.revokeGrant(g.token).catch((e) => toast(e.message));
    reload();
  };

  return (
    <div class="set-block">
      <div class="set-block-head"><span class="set-block-title">已授权设备</span></div>
      <div class="set-block-desc">
        本机签发、允许其他设备同步进来的凭据。吊销即断开对方的入站访问。
      </div>
      <div class="peer-list flush">
        {grants == null ? (
          <div class="muted">加载中…</div>
        ) : grants.length === 0 ? (
          <div class="muted">还没有签发任何凭据。</div>
        ) : (
          grants.map((g) => (
            <div key={g.token} class="peer-row">
              <span class="peer-dot on" />
              <div class="peer-main">
                <div class="peer-url">{g.peer_url || "(未知地址)"}</div>
                <div class="peer-sub">
                  {g.token.slice(0, 8)}… · 签发于 {fmtTime(g.created_at)}
                </div>
              </div>
              <button class="btn btn-ghost peer-menu" title="吊销" onClick={() => revoke(g)}>
                <Icon name="trash" cls="ico sm" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function PairingCodeModal({ code, exp }: { code: string; exp: number }) {
  const [left, setLeft] = useState(Math.max(0, Math.round((exp - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.round((exp - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [exp]);
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  return (
    <Modal
      title="本机配对码"
      sub="在另一台设备上输入此服务器地址和下面的配对码即可配对。配对码一次性使用。"
      footer={<button class="btn btn-primary" onClick={closeModal}>完成</button>}
    >
      <div class="pair-code">{code}</div>
      <div class="muted" style={{ textAlign: "center", marginTop: 8 }}>
        {left > 0 ? `${mm}:${ss} 后过期` : "已过期，请重新生成"}
      </div>
      <button
        class="btn btn-secondary"
        style={{ width: "100%", marginTop: 12 }}
        onClick={() => {
          navigator.clipboard?.writeText(code);
          toast("已复制配对码");
        }}
      >
        <Icon name="copy" cls="ico sm" /> 复制
      </button>
    </Modal>
  );
}

function AddPeerModal({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [selfUrl, setSelfUrl] = useState(location.origin);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!url.trim() || !code.trim()) {
      toast("地址和配对码必填");
      return;
    }
    setBusy(true);
    try {
      const r = await api.addPeerByPairing({
        url: url.trim(),
        code: code.trim(),
        self_url: selfUrl.trim() || undefined,
      });
      await api.syncPeer(r.url).catch(() => {});
      toast(`已配对 ${r.url}`);
      onDone();
    } catch (e) {
      toast(`配对失败：${(e as Error).message}`);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="添加同步设备"
      sub="输入对方 Metahub 服务器的地址，以及它生成的一次性配对码。"
      footer={
        <>
          <button class="btn btn-secondary" onClick={closeModal} disabled={busy}>取消</button>
          <button class="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "配对中…" : "配对"}
          </button>
        </>
      }
    >
      <div class="field-label">对方服务器地址</div>
      <input
        class="text-input"
        autofocus
        placeholder="http://192.168.1.10:7777"
        value={url}
        onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
      />
      <div class="field-label">配对码</div>
      <input
        class="text-input"
        placeholder="对方「生成本机配对码」得到的码"
        value={code}
        onInput={(e) => setCode((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <div class="field-label">本机可达地址（可选）</div>
      <input
        class="text-input"
        placeholder="留空则仅本机主动同步"
        value={selfUrl}
        onInput={(e) => setSelfUrl((e.target as HTMLInputElement).value)}
      />
    </Modal>
  );
}
