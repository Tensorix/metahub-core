/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import type { S3Config } from "../core/sync/storage.ts";
import { Icon } from "./icons.tsx";
import { getTheme, setTheme, type ThemeChoice } from "./theme.ts";
import { api, currentToken, type Peer, type Grant, type S3Peer } from "./api.ts";
import {
  replicaEnabled,
  replicaStatus,
  onReplicaStatus,
  enableReplica,
  disableReplica,
  resetReplica,
  requestSync,
  isNoOrigin,
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

/** Inside the desktop shell (Electron + local sidecar) the sidecar IS the data
 *  home — it stores everything on disk directly, so the "browser client" model
 *  (window vs replica, an OPFS replica, re-entering a bucket secret to direct-
 *  connect) doesn't apply. The 同步 section collapses to "connect a bucket so
 *  every device stays in sync"; device-to-device HTTP pairing (设备与授权) stays. */
const isDesktop = () => typeof window !== "undefined" && !!window.metahubDesktop;

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

      {/* One "同步" chapter (doc 19): how THIS device uses the workspace
          (lightweight / trusted), then the cloud bucket that keeps every device
          in sync. The bucket lives on the server (origin) or this device
          (no-origin); shown in either mode so its ownership is never hidden. */}
      <SetGroup label="同步">
        {!isDesktop() && <DeviceSetup />}
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

// ---- mode diagram: a small animated topology ------------------------------
// "How is this device wired right now?" as a schematic shown on the right when
// a mode card is hovered. It reflects REAL state, not just the mode: 本设备↔服务器
// (origin), 服务器→云桶 when the server publishes a bucket, and a direct 本设备→云桶
// link only when THIS device has actually connected one. The self node reads
// solid (信任) or hollow (轻量). See docs/impl-context/19-client-topology.

function ModeDiagram({
  kind,
  noOrigin,
  hasServerBucket,
  deviceDirect,
}: {
  kind: "light" | "trusted";
  noOrigin: boolean;
  hasServerBucket: boolean;
  deviceDirect: boolean;
}) {
  const trusted = kind === "trusted";
  const showServer = !noOrigin;
  // 服务器→云桶 when the server publishes a bucket; 本设备→云桶 only when this device
  // has actually connected one directly. The bucket node shows if either holds.
  const serverToBucket = showServer && hasServerBucket;
  const directToBucket = deviceDirect;
  const showBucket = serverToBucket || directToBucket;
  // Draw the direct link as a bypass under the chain only when a server sits
  // between the two (no-origin already draws it as the plain self→bucket wire).
  const bypass = directToBucket && showServer && showBucket;

  return (
    <span
      class={"md-graph" + (trusted ? " trusted" : " light") + (bypass ? " has-direct" : "")}
      aria-hidden="true"
    >
      <span class="md-node self">
        <span class="md-node-ico"><Icon name="monitor" cls="ico" /></span>
        <span class="md-node-name">本设备</span>
        <span class="md-node-tag">{trusted ? "存一份" : "不留存"}</span>
      </span>
      {showServer && (
        <>
          <span class="md-wire bi" />
          <span class="md-node">
            <span class="md-node-ico"><Icon name="globe" cls="ico" /></span>
            <span class="md-node-name">服务器</span>
          </span>
        </>
      )}
      {showBucket && (
        <>
          <span class={"md-wire " + (showServer ? "to" : "bi")} />
          <span class="md-node">
            <span class="md-node-ico"><Icon name="cube" cls="ico" /></span>
            <span class="md-node-name">云桶</span>
          </span>
        </>
      )}
      {bypass && <span class="md-direct" data-label="直连" />}
    </span>
  );
}

/**
 * "设置这台设备" — the per-device decision, framed as two cards: 轻量模式 (a plain
 * online window — fast, nothing kept here) vs 信任此设备 (turn THIS browser into a
 * CRDT sync node: pair with the server, hydrate a full local OPFS replica, then
 * read/write locally with background /sync). Hovering a card reveals its wiring
 * as a ModeDiagram on the right (no persistent diagram). The issued grant
 * appears under 已授权设备 and can be revoked server-side anytime.
 */
function DeviceSetup() {
  const unsupported = replicaUnsupportedReason();
  const [enabled, setEnabled] = useState(replicaEnabled());
  const [st, setSt] = useState<ReplicaStatus>(replicaStatus());
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<string | null>(null);
  // Drives ModeDiagram's shape: no server node to draw in a bucket-only shell.
  const noOrigin = isNoOrigin();
  // Real wiring the diagram reflects: does the server publish a bucket, and has
  // THIS device connected one directly? (so the 云桶 edges are state-driven.)
  const [hasServerBucket, setHasServerBucket] = useState(false);
  const [deviceDirect, setDeviceDirect] = useState(false);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const direct = replicaEnabled()
        ? (await replicaCall<unknown[]>("listStoragePeers").catch(() => [])).length > 0
        : false;
      const serverHas = noOrigin
        ? false
        : (await api.listServerS3Peers().catch(() => [])).length > 0;
      if (!live) return;
      setDeviceDirect(direct);
      setHasServerBucket(serverHas);
    };
    load();
    const off = onReplicaStatus(load);
    return () => {
      live = false;
      off();
    };
  }, [noOrigin]);
  // Which card's wiring to preview, and where to float it — out in the page's
  // right margin (fixed, beside the content column), hover/focus only. Null when
  // nothing is hovered or the window is too narrow to have a right margin.
  const [preview, setPreview] = useState<{ kind: "light" | "trusted"; top: number; left: number } | null>(null);
  const showAside = (kind: "light" | "trusted", e: { currentTarget: EventTarget | null }) => {
    const el = e.currentTarget as HTMLElement | null;
    const panel = el?.closest(".set-panel");
    const cards = el?.closest(".sync-holds");
    if (!panel || !cards) return;
    const pr = panel.getBoundingClientRect();
    const W = 248, GAP = 28;
    // No room to the right of the content column → don't show it at all.
    if (window.innerWidth - pr.right < W + GAP) return setPreview(null);
    // Re-read bucket wiring so the diagram reflects buckets added/removed since
    // mount (that happens over in 在所有设备间同步, which doesn't notify this block).
    void (async () => {
      const direct = replicaEnabled()
        ? (await replicaCall<unknown[]>("listStoragePeers").catch(() => [])).length > 0
        : false;
      const serverHas = noOrigin ? false : (await api.listServerS3Peers().catch(() => [])).length > 0;
      setDeviceDirect(direct);
      setHasServerBucket(serverHas);
    })();
    setPreview({ kind, left: pr.right + GAP, top: cards.getBoundingClientRect().top });
  };
  const hideAside = () => setPreview(null);

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
    if (!enabled) return "轻量模式 · 仅在线读写，断网不可用。";
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
        <div class="set-block-head"><span class="set-block-title">设置这台设备</span></div>
        <div class="set-block-desc">这台设备为轻量模式:仅在线读写,不在本机保存。</div>
        <div class="peer-sub" style="margin-top:8px">⚠ 此设备无法「信任并本机保存」:{unsupported}</div>
      </div>
    );
  }

  const diagram = (kind: "light" | "trusted") => (
    <ModeDiagram
      kind={kind}
      noOrigin={noOrigin}
      hasServerBucket={hasServerBucket}
      // a lightweight window never keeps a direct bucket link
      deviceDirect={kind === "trusted" && deviceDirect}
    />
  );

  return (
    <div class="set-block">
      <div class="set-block-head"><span class="set-block-title">设置这台设备</span></div>
      <div class="set-block-desc">选择这台设备如何使用工作区,之后可随时修改。</div>
      <div class="theme-grid sync-holds">
        <button
          class={"theme-card mode-card" + (!enabled ? " sel" : "")}
          aria-pressed={!enabled}
          disabled={busy}
          onClick={() => enabled && disable()}
          onMouseEnter={(e) => showAside("light", e)}
          onMouseLeave={hideAside}
          onFocus={(e) => showAside("light", e)}
          onBlur={hideAside}
        >
          <span class="tc-check"><Icon name="check" /></span>
          <span class="tc-ico"><Icon name="globe" /></span>
          <span class="mode-text">
            <span class="tc-name">轻量模式</span>
            <span class="tc-desc">仅在线使用</span>
          </span>
        </button>
        <button
          class={"theme-card mode-card" + (enabled ? " sel" : "")}
          aria-pressed={enabled}
          disabled={busy}
          onClick={() => !enabled && enable()}
          onMouseEnter={(e) => showAside("trusted", e)}
          onMouseLeave={hideAside}
          onFocus={(e) => showAside("trusted", e)}
          onBlur={hideAside}
        >
          <span class="tc-check"><Icon name="check" /></span>
          <span class="tc-ico"><Icon name="lock" /></span>
          <span class="mode-text">
            <span class="tc-name">信任此设备</span>
            <span class="tc-desc">{busy && !enabled ? "启用中…" : "本机保存,支持同步"}</span>
          </span>
        </button>
      </div>
      {preview && (
        <div class="mode-aside" style={{ top: preview.top + "px", left: preview.left + "px" }}>
          <div class="mp-show">
            {diagram(preview.kind)}
            <span class="mp-cap">
              {preview.kind === "trusted" ? "本机存一份 · 离线也能读写" : "仅在线读写 · 不在本机保存"}
            </span>
          </div>
        </div>
      )}
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
  bucket?: string | null;
  endpoint?: string | null;
}

/** Host of an endpoint URL for compact row display ("…r2.cloudflarestorage.com"). */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** Mask a credential id for read-only display — keep the head/tail, dot the rest. */
function maskKey(s: string): string {
  return s.length <= 8 ? s.slice(0, 2) + "…" : s.slice(0, 4) + "…" + s.slice(-4);
}

/**
 * Point THIS browser's local replica at an S3-compatible bucket (R2/MinIO/S3)
 * used as dumb store-and-forward — so it syncs with your other devices without
 * any of them running a public server, and even when they're offline. The
 * bucket peer lives in this browser's replica DB and is driven by the worker's
 * sync loop, so it requires the offline replica to be enabled first.
 */
function SyncStorage() {
  // Two modes (doc 19) with very different ownership — kept from bleeding:
  //  • origin (has a server): buckets are configured ON the server (the data
  //    home + publisher) and mirrored here read-only, even in window mode. A
  //    replica may ALSO sync a bucket directly by re-entering ONLY the secret
  //    (which never travels down) — a per-device away-from-server fallback.
  //  • no-origin (bucket-only shell): this browser IS the home, so it configures
  //    buckets into its own local replica and publishes them. No server, no
  //    "re-enter the secret", no ownership to disambiguate — one subject.
  const noOrigin = isNoOrigin();
  // Desktop: the sidecar holds the data and connects buckets directly — render a
  // plain bucket list (server peers, no per-device direct-connect tags). The
  // shared add()/syncNow()/removeBucket() already behave right here because the
  // renderer never runs a replica (enabled stays false) and isn't no-origin.
  const desktop = isDesktop();
  const [enabled, setEnabled] = useState(replicaEnabled());
  // origin: the server's buckets (source of truth). no-origin: unused.
  const [serverPeers, setServerPeers] = useState<S3Peer[] | null>(null);
  // Buckets THIS device's replica syncs directly. In no-origin this IS the list;
  // in origin it's the subset a replica has re-activated locally (by url).
  const [localPeers, setLocalPeers] = useState<StoragePeerView[] | null>(null);

  // Pull just this device's direct-connect list. Called on mount AND on every
  // replica status change so a page refresh that lands here recovers: the very
  // first reload races ahead of resumeReplicaIfEnabled() (child effects run
  // before the app-root one), so replicaCall rejects with "replica not running"
  // before `started` flips — retrying once the replica reaches "ready" fills it
  // in. Keep the previous list on failure (don't null it) and never toast here.
  const reloadLocal = () => {
    if (replicaEnabled()) {
      replicaCall<StoragePeerView[]>("listStoragePeers")
        .then(setLocalPeers)
        .catch(() => {});
    } else {
      setLocalPeers(null);
    }
  };

  const reload = () => {
    reloadLocal();
    if (!noOrigin) {
      api
        .listServerS3Peers()
        .then(setServerPeers)
        .catch((e) => toast(`加载失败：${(e as Error).message}`));
    }
  };

  useEffect(() => {
    reload();
    return onReplicaStatus(() => {
      setEnabled(replicaEnabled());
      reloadLocal();
    });
  }, []);

  // origin: set of server bucket urls this device already syncs directly.
  const localUrls = new Set((localPeers ?? []).map((p) => p.url));

  // Desktop never runs the renderer replica (app.tsx skips resume there), so the
  // bucket peer lives only on the sidecar — ignore any stale mh_replica flag a
  // prior version may have left, which would otherwise make these handlers hit a
  // worker that isn't running.
  const replicaOn = !desktop && enabled;

  const add = () =>
    openModal(
      <AddStorageModal
        toServer={!noOrigin}
        alsoReplica={!noOrigin && replicaOn}
        onDone={() => {
          closeModal();
          reload();
        }}
      />,
    );

  // origin + replica: re-enter only the secret so THIS device's replica syncs a
  // server bucket directly (the server never sends the secret to the browser).
  const activateHere = (p: S3Peer) =>
    openModal(
      <ActivateBucketOnDeviceModal
        peer={p}
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
        await Promise.all((serverPeers ?? []).map((p) => api.syncPeer(p.url)));
        // A replica that also peers buckets directly — flush it too.
        if (replicaOn) await replicaCall("sync").catch(() => {});
      }
      toast("已触发同步");
      reload();
    } catch (e) {
      toast(`同步失败：${(e as Error).message}`);
    }
  };

  // Remove the bucket backend entirely (server-side, and this device's copy).
  const removeBucket = async (url: string, name: string) => {
    const ok = await confirmDialog({
      title: "移除存储桶",
      message: `确定移除 ${name}？将停止与该存储桶同步（桶内数据不受影响）。`,
      confirmLabel: "移除",
      danger: true,
    });
    if (!ok) return;
    if (noOrigin) {
      await replicaCall("removeStorageReplica", url).catch((e) => toast((e as Error).message));
    } else {
      await api.removePeer(url).catch((e) => toast((e as Error).message));
      // Drop the replica's own copy of the bucket peer too, if it attached one.
      if (replicaOn) await replicaCall("removeStorageReplica", url).catch(() => {});
    }
    reload();
  };

  // origin + replica: drop only THIS device's direct link; the bucket stays on
  // the server (this device keeps syncing it via the server when online).
  const detachHere = async (url: string, name: string) => {
    const ok = await confirmDialog({
      title: "取消本设备直连",
      message: `这台设备将不再直连 ${name}（存储桶仍在服务器上;本设备在线时照常经服务器同步）。`,
      confirmLabel: "取消直连",
      danger: true,
    });
    if (!ok) return;
    await replicaCall("removeStorageReplica", url).catch((e) => toast((e as Error).message));
    reload();
  };

  // Show a QR a phone scans to enroll the same bucket (no manual typing): the
  // link carries the bucket credentials but never the passphrase — the phone
  // types that. The shell base URL is configurable, never hardcoded.
  const openPhone = async (url: string) => {
    try {
      // Desktop has no replica to read the config from; the sidecar serves the
      // full (incl. secret) bucket config on its master-token-gated /api surface.
      const config = desktop
        ? await api.serverS3Config(url)
        : await replicaCall<S3Config | null>("storagePeerConfig", url);
      if (!config) return toast("找不到该存储的配置");
      openModal(<QrModal config={config} />);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const rowMenu = (e: MouseEvent, p: S3Peer, onDevice: boolean) =>
    openMenu(e, (close) => (
      <>
        {onDevice && (
          <MenuItem
            icon="link"
            label="取消本设备直连"
            onClick={() => {
              close();
              detachHere(p.url, p.label || p.bucket || p.url);
            }}
          />
        )}
        <MenuItem
          icon="trash"
          label="移除存储桶"
          danger
          onClick={() => {
            close();
            removeBucket(p.url, p.label || p.bucket || p.url);
          }}
        />
      </>
    ));

  const hasRows = (noOrigin ? localPeers : serverPeers)?.length ? true : false;

  return (
    <div class="set-block">
      <div class="set-block-head"><span class="set-block-title">在所有设备间同步</span></div>
      <div class="set-block-desc">
        连一个云端存储桶,手机、电脑就保持同步——不必开公网服务器,对方离线也收得到,内容端到端加密。
      </div>

      <div class="set-meta">
        <span class="set-meta-item">
          <Icon name={desktop || !noOrigin ? "globe" : "cube"} cls="ico sm" />
          {desktop
            ? "连一个云端存储桶,这台设备就和你的手机、其他电脑自动保持同步。"
            : noOrigin
              ? "这台设备就是工作区的家,其他设备扫码加入即可一起同步。"
              : "存储桶连在服务器上,所有设备自动共享;信任本设备后,它离线、在外时也能直接同步。"}
        </span>
      </div>

      <details class="set-disclosure">
        <summary>它是怎么工作的</summary>
        <div class="set-disclosure-body">
          存储桶只当"哑"中转:每台设备把自己的变更加密上传、再拉取别人的——谁都不必同时在线,也不需要公网 IP。
          {desktop
            ? "这台设备把自己的变更发布到桶,其他设备从桶拉取;新设备扫码加入即可一起同步。"
            : noOrigin
              ? "这台设备把整个工作区发布到桶,新设备扫码加入后从桶秒恢复。"
              : "密钥只存在服务器,不会同步到浏览器;信任的设备重输一次密钥即可直接同步,离线、在外也不中断。添加时会自动为本站点开通桶的访问权限(CORS)。"}
        </div>
      </details>

      {noOrigin && !enabled ? (
        <div class="peer-sub" style="margin-top:12px">⚠ 请先在上方把这台设备设为「信任此设备」,再连接存储桶。</div>
      ) : (
        <>
          <div class="peer-actions" style={{ marginTop: 14 }}>
            <button class="btn btn-primary" onClick={add}>
              <Icon name="plus" cls="ico sm" /> 连接存储桶
            </button>
            {hasRows && (
              <button class="btn btn-secondary" onClick={syncNow}>
                <Icon name="share" cls="ico sm" /> 立即同步
              </button>
            )}
          </div>

          <div class="peer-list flush">
            {desktop
              ? serverPeers == null
                ? <div class="muted">加载中…</div>
                : serverPeers.length === 0
                  ? <div class="muted">还没连接存储桶——连一个,所有设备就能保持同步。</div>
                  : serverPeers.map((p) => {
                      const name = p.label || p.bucket || p.url;
                      return (
                        <div key={p.url} class="peer-row">
                          <span class={"peer-dot" + (p.enabled ? (p.status === "error" ? " err" : " on") : " off")} />
                          <div class="peer-main">
                            <div class="peer-url">{name}</div>
                            <div class="peer-sub">
                              {p.endpoint ? hostOf(p.endpoint) + " · " : ""}最近同步 {fmtTime(p.lastSyncAt)}
                              {p.status === "error" && p.error ? ` · 错误:${p.error}` : ""}
                            </div>
                          </div>
                          <button class="btn btn-ghost peer-menu" title="在手机上打开" onClick={() => openPhone(p.url)}>
                            <Icon name="share" cls="ico sm" />
                          </button>
                          <button class="btn btn-ghost peer-menu" title="移除" onClick={() => removeBucket(p.url, name)}>
                            <Icon name="trash" cls="ico sm" />
                          </button>
                        </div>
                      );
                    })
              : noOrigin
              ? localPeers == null
                ? <div class="muted">加载中…</div>
                : localPeers.length === 0
                  ? <div class="muted">还没连接存储桶——连一个,手机、电脑就能免公网服务器互通。</div>
                  : localPeers.map((p) => {
                      const name = p.label || p.bucket || p.url;
                      return (
                        <div key={p.url} class="peer-row">
                          <span class={"peer-dot" + (p.enabled ? (p.status === "error" ? " err" : " on") : " off")} />
                          <div class="peer-main">
                            <div class="peer-url">{name}</div>
                            <div class="peer-tags">
                              <span class="peer-tag"><Icon name="upload" cls="ico" /> 本机发布</span>
                            </div>
                            <div class="peer-sub">
                              {p.endpoint ? hostOf(p.endpoint) + " · " : ""}最近同步 {fmtTime(p.lastSyncAt)}
                              {p.status === "error" && p.error ? ` · 错误:${p.error}` : ""}
                            </div>
                          </div>
                          <button class="btn btn-ghost peer-menu" title="在手机上打开" onClick={() => openPhone(p.url)}>
                            <Icon name="share" cls="ico sm" />
                          </button>
                          <button class="btn btn-ghost peer-menu" title="移除" onClick={() => removeBucket(p.url, name)}>
                            <Icon name="trash" cls="ico sm" />
                          </button>
                        </div>
                      );
                    })
              : serverPeers == null
                ? <div class="muted">加载中…</div>
                : serverPeers.length === 0
                  ? <div class="muted">还没连接存储桶——连一个,所有设备就能免公网服务器互通。</div>
                  : serverPeers.map((p) => {
                      const name = p.label || p.bucket || p.url;
                      const onDevice = enabled && localUrls.has(p.url);
                      return (
                        <div key={p.url} class="peer-row">
                          <span class={"peer-dot" + (p.enabled ? (p.status === "error" ? " err" : " on") : " off")} />
                          <div class="peer-main">
                            <div class="peer-url">{name}</div>
                            <div class="peer-tags">
                              <span class="peer-tag"><Icon name="globe" cls="ico" /> 服务器同步</span>
                              {enabled ? (
                                onDevice ? (
                                  <span class="peer-tag ok"><Icon name="link" cls="ico" /> 本机已直连</span>
                                ) : (
                                  <button class="peer-tag act" onClick={() => activateHere(p)}>
                                    <Icon name="link" cls="ico" /> 让本机直接同步
                                  </button>
                                )
                              ) : (
                                <span class="peer-tag muted">信任本设备后可直连</span>
                              )}
                            </div>
                            <div class="peer-sub">
                              {p.endpoint ? hostOf(p.endpoint) + " · " : ""}最近同步 {fmtTime(p.lastSyncAt)}
                              {p.status === "error" && p.error ? ` · 错误:${p.error}` : ""}
                            </div>
                          </div>
                          <button class="btn btn-ghost peer-menu" title="更多" onClick={(e) => rowMenu(e as unknown as MouseEvent, p, onDevice)}>
                            <Icon name="dots" cls="ico sm" />
                          </button>
                        </div>
                      );
                    })}
          </div>
        </>
      )}
    </div>
  );
}

/** origin + replica only: a server bucket is already configured (the server is
 *  its publisher), but the server never sends the secret down to the browser.
 *  Re-enter just the secret (and the shared passphrase, when encrypted) to let
 *  THIS device's replica sync with the bucket directly — its own away-from-
 *  server fallback. Every other field is prefilled from the server's non-secret
 *  view; we attach as a non-publisher (publish:false). */
function ActivateBucketOnDeviceModal({ peer, onDone }: { peer: S3Peer; onDone: () => void }) {
  const [secretKey, setSecretKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const host = peer.endpoint ? hostOf(peer.endpoint) : "";

  const submit = async () => {
    if (!secretKey.trim()) return toast("密钥必填");
    if (peer.encrypt && !passphrase) return toast("加密口令必填");
    if (!peer.endpoint || !peer.bucket || !peer.accessKeyId) {
      return toast("服务器未提供该桶的完整配置,无法在本设备激活");
    }
    setBusy(true);
    try {
      const config: S3Config = {
        endpoint: peer.endpoint,
        region: peer.region || "auto",
        bucket: peer.bucket,
        prefix: peer.prefix || "metahub",
        accessKeyId: peer.accessKeyId,
        secretAccessKey: secretKey.trim(),
        encrypt: peer.encrypt,
        ...(peer.virtualHostedStyle != null ? { virtualHostedStyle: peer.virtualHostedStyle } : {}),
        publish: false,
      };
      await replicaCall("addStorageReplica", config, passphrase);
      toast("已让本机直连存储桶 · 离线、在外也能直接同步");
      onDone();
    } catch (e) {
      const msg = (e as Error).message;
      toast(
        looksLikeCors(msg)
          ? "连接被浏览器拦截：请给存储桶配置 CORS，允许此源的 GET/PUT/HEAD/DELETE。"
          : `启用失败：${msg}`,
      );
      setBusy(false);
    }
  };

  return (
    <Modal
      title="在本设备启用直连"
      sub="服务器已配置这个存储桶。为保护密钥,服务器不会把它同步到浏览器——再输入一次密钥,这台设备就能与桶直接同步(离线、在外也不中断)。"
      footer={
        <>
          <button class="btn btn-secondary" onClick={closeModal} disabled={busy}>取消</button>
          <button class="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "连接中…" : "启用直连"}
          </button>
        </>
      }
    >
      <div class="activate-id">
        <div class="activate-id-row"><span>存储桶</span><b>{peer.bucket}</b></div>
        {host && <div class="activate-id-row"><span>服务地址</span><b>{host}</b></div>}
        {peer.accessKeyId && (
          <div class="activate-id-row"><span>访问密钥 ID</span><b>{maskKey(peer.accessKeyId)}</b></div>
        )}
      </div>
      <div class="field-label">密钥</div>
      <input
        class="text-input"
        type="password"
        autofocus
        placeholder="重新输入该桶的密钥"
        value={secretKey}
        onInput={(e) => setSecretKey((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => !peer.encrypt && e.key === "Enter" && submit()}
      />
      {peer.encrypt && (
        <>
          <div class="field-label">加密口令</div>
          <input
            class="text-input"
            type="password"
            placeholder="与其它设备相同的加密口令"
            value={passphrase}
            onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <div class="set-hint">跨设备共用的那把加密钥——用它解开桶里别人的数据。</div>
        </>
      )}
    </Modal>
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

/** Provider presets — prefill the right region + endpoint shape + a one-line
 *  hint, so the user isn't staring at a blank "endpoint" field wondering what an
 *  S3 endpoint even is. Purely a convenience over the same underlying S3 fields;
 *  COS uses virtual-hosted addressing (auto-detected when the endpoint host
 *  starts with the bucket name — see storage-s3-bun §13). */
const S3_PROVIDERS = [
  { id: "r2", name: "Cloudflare R2", region: "auto", ph: "https://<账户ID>.r2.cloudflarestorage.com", hint: "R2 控制台 → 管理 R2 API 令牌,创建 S3 凭据;区域填 auto。免费额度 10GB。" },
  { id: "s3", name: "Amazon S3", region: "us-east-1", ph: "https://s3.<区域>.amazonaws.com", hint: "IAM 用户的访问密钥;区域如 us-east-1。" },
  { id: "minio", name: "MinIO", region: "us-east-1", ph: "https://minio.你的域名", hint: "自建 MinIO 的访问地址与 access / secret key。" },
  { id: "cos", name: "腾讯云 COS", region: "ap-shanghai", ph: "https://<桶名-APPID>.cos.<区域>.myqcloud.com", hint: "桶名须含 APPID,用虚拟主机风格地址(host 以桶名开头)。" },
  { id: "custom", name: "自定义", region: "auto", ph: "https://s3.example.com", hint: "任何 S3 兼容对象存储。" },
] as const;

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
  const [provider, setProvider] = useState<string>("r2");
  const prov = S3_PROVIDERS.find((p) => p.id === provider) ?? S3_PROVIDERS[4];
  // Switch provider → adopt its region, but never clobber a region the user
  // typed (only overwrite when it's still one of the presets' defaults).
  const pickProvider = (id: string) => {
    setProvider(id);
    const p = S3_PROVIDERS.find((x) => x.id === id);
    if (p && S3_PROVIDERS.some((x) => x.region === region)) setRegion(p.region);
  };

  const submit = async () => {
    if (!endpoint.trim() || !bucket.trim() || !accessKey.trim() || !secretKey.trim()) {
      toast("服务地址、桶名称、访问密钥 ID、密钥都要填");
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
      if (toServer) {
        await api.addServerS3Peer({ ...config, passphrase, corsOrigins: [location.origin] });
        if (alsoReplica) {
          await replicaCall("addStorageReplica", { ...config, publish: false }, passphrase);
        }
      } else {
        await replicaCall("addStorageReplica", config, passphrase);
      }
      toast(
        toServer
          ? alsoReplica
            ? "已连接存储桶 · 服务器开始同步到桶,这台设备也直接同步"
            : "已连接存储桶 · 服务器开始同步到桶"
          : "已连接存储桶 · 这台设备开始同步到桶",
      );
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
      title="连接存储桶"
      sub="连接一个 S3 兼容存储桶,所有设备就能同步——不需要公网服务器。新桶自动初始化;已有桶用相同加密口令即可加入。"
      footer={
        <>
          <button class="btn btn-secondary" onClick={closeModal} disabled={busy}>取消</button>
          <button class="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "连接中…" : "连接"}
          </button>
        </>
      }
    >
      <div class="field-label">存储服务商</div>
      <div class="provider-grid">
        {S3_PROVIDERS.map((p) => (
          <button
            key={p.id}
            class={"provider-chip" + (provider === p.id ? " sel" : "")}
            aria-pressed={provider === p.id}
            onClick={() => pickProvider(p.id)}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div class="set-hint">{prov.hint}</div>

      <div class="field-label">服务地址</div>
      <input
        class="text-input"
        autofocus
        placeholder={prov.ph}
        value={endpoint}
        onInput={(e) => setEndpoint((e.target as HTMLInputElement).value)}
      />
      <div class="field-label">桶名称</div>
      <input
        class="text-input"
        placeholder="my-metahub"
        value={bucket}
        onInput={(e) => setBucket((e.target as HTMLInputElement).value)}
      />
      <div class="field-label">访问密钥 ID</div>
      <input
        class="text-input"
        placeholder="Access Key ID"
        value={accessKey}
        onInput={(e) => setAccessKey((e.target as HTMLInputElement).value)}
      />
      <div class="field-label">密钥</div>
      <input
        class="text-input"
        type="password"
        placeholder="Secret Access Key"
        value={secretKey}
        onInput={(e) => setSecretKey((e.target as HTMLInputElement).value)}
      />

      <label class="set-check-row" style={{ marginTop: 14 }}>
        <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt((e.target as HTMLInputElement).checked)} />
        <span>端到端加密(强烈建议;关闭后文件以明文存放,仅限完全信任的存储)</span>
      </label>
      {encrypt && (
        <>
          <div class="field-label">加密口令</div>
          <input
            class="text-input"
            type="password"
            placeholder="新桶以此创建;其它设备用同一口令加入"
            value={passphrase}
            onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <div class="set-hint">这是跨设备共用的一把加密钥——记牢它,换设备 / 加入已有桶时都要用它解开数据。</div>
        </>
      )}

      <details class="set-disclosure" style={{ marginTop: 14 }}>
        <summary>进阶</summary>
        <div class="set-disclosure-body">
          <div class="field-label" style={{ marginTop: 0 }}>区域</div>
          <input
            class="text-input"
            placeholder={prov.region}
            value={region}
            onInput={(e) => setRegion((e.target as HTMLInputElement).value)}
          />
          <div class="set-hint">大多按服务商默认即可(R2 用 auto)。</div>
          <div class="field-label">路径前缀</div>
          <input
            class="text-input"
            placeholder="metahub"
            value={prefix}
            onInput={(e) => setPrefix((e.target as HTMLInputElement).value)}
          />
          <div class="set-hint">同一个桶里隔离多个工作区时用;默认 metahub。</div>
        </div>
      </details>
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
