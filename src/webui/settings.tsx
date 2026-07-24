/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { S3Config } from "../core/sync/storage.ts";
import { Icon } from "./icons.tsx";
import { getTheme, setTheme, type ThemeChoice } from "./theme.ts";
import { getWordCountEnabled, setWordCountEnabled } from "./wordcount.ts";
import { timeAgo } from "./date.ts";
import {
  api,
  type Peer,
  type S3Peer,
  type BlobCacheInfo,
  type EdgeStatus,
  type DataMap,
  type DeviceView,
  type NodeInfo,
} from "./api.ts";
import {
  dataMapHeadline,
  dataMapTone,
  placeCaption,
  PLACE_KIND_LABEL,
  PLACE_ROLE_LABEL,
} from "./data-map-status.ts";
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
import { cacheStats, clearCache, spoolPending, BLOB_QUOTA_BYTES } from "./data/blob-store.ts";
import { cmpVer, WEBUI_VERSION } from "./version.ts";
import { openBlobManager } from "./blob-manager.tsx";
import { scopesFor, type Scope } from "./data/scopes.ts";
import { openModal, closeModal, toast, confirmDialog } from "./ui.tsx";
import {
  EdgeDeployModal,
  ActivateBucketOnDeviceModal,
  AddStorageModal,
  AddDeviceModal,
  RotateModal,
  RecoveryCodeModal,
} from "./settings/modals.tsx";
import {
  isDesktop,
  fmtBytes,
  fmtTime,
  hostOf,
  replicaUnsupportedReason,
  type StoragePeerView,
} from "./settings/shared.ts";
import { GROUPS, resolvePage, pageLabel, type PageId } from "./settings/nav.ts";
import { SetRow, Switch, SetSection, PageHeader, DangerZone, RowMenu } from "./settings/primitives.tsx";
import { CacheRingHero, type RingState } from "./settings/cache-ring.tsx";

const THEMES: { value: ThemeChoice; icon: string; name: string; desc: string }[] = [
  { value: "light", icon: "sun", name: "浅色", desc: "始终使用明亮界面" },
  { value: "dark", icon: "moon", name: "深色", desc: "始终使用暗色界面" },
  { value: "system", icon: "monitor", name: "跟随系统", desc: "随操作系统外观自动切换" },
];

/** Jump to a settings page. Selection is URL-driven: app.tsx re-renders this
 *  view on every location.hash change (view.ts parses ?sec=). */
const gotoPage = (id: PageId) => {
  location.hash = "#/settings?sec=" + id;
};

const NARROW_BP = 760; // .set-shell width below which the rail can't fit

/** Wide vs narrow layout is decided by the shell's own width — the app sidebar
 *  is resizable, so a viewport media query would misjudge the content area.
 *  JS is the single authority (the rail / index render conditionally); no CSS
 *  container query left to disagree with the tree. First frame guesses from
 *  the viewport, corrected before first paint. */
function useShellNarrow() {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth - 268 < NARROW_BP);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number) => setNarrow(w < NARROW_BP);
    apply(el.offsetWidth);
    const ro = new ResizeObserver((es) => apply(es[0]!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, narrow] as const;
}

/** The device group's header: this device's name, renamable inline. Shared
 *  between the wide rail and the narrow index — only one mounts at a time.
 *
 *  Which node it names is DETERMINISTIC per client config, never per-call
 *  timing: with the offline replica enabled this client IS the browser node —
 *  read/write go straight to the worker (retried via onReplicaStatus while it
 *  boots) — otherwise the answering node is the server/sidecar over HTTP.
 *  Routing through the api proxy instead (replicaActive()) once made a rename
 *  write to one node and the next read hit the other, so edits seemed to
 *  vanish. Reads use the raw nodes roster (label nullable), NOT the data map,
 *  whose display layer coalesces an unset label to 本机 — unset must stay
 *  distinguishable here so the 此设备 placeholder can show. */
function DeviceGroupName() {
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // One commit per edit session: Enter commits, then the input unmounts and
  // its blur fires again — and Escape must NOT let that blur commit.
  const closed = useRef(false);
  const selfNodes = (): Promise<NodeInfo[]> =>
    replicaEnabled() ? replicaCall<NodeInfo[]>("nodes") : api.nodes();
  const loadLabel = () =>
    selfNodes()
      .then((ns) => setDeviceLabel(ns.find((n) => n.self)?.label ?? null))
      .catch(() => undefined); // worker still booting — the status retry covers it
  useEffect(() => {
    void loadLabel();
    return onReplicaStatus(() => void loadLabel());
  }, []);
  const commit = async (v: string) => {
    if (closed.current) return;
    closed.current = true;
    setEditing(false);
    const label = v.trim() || null;
    try {
      if (replicaEnabled()) await replicaCall("setNodeLabel", label);
      else await api.setNodeLabel(label);
    } catch (e) {
      toast(`重命名失败：${(e as Error).message}`);
    }
    void loadLabel();
  };
  const cancel = () => {
    closed.current = true;
    setEditing(false);
  };
  return editing ? (
    <input
      class="set-rail-rename"
      autofocus
      value={deviceLabel ?? ""}
      onKeyDown={(e) => {
        if (e.key === "Enter") void commit((e.target as HTMLInputElement).value);
        if (e.key === "Escape") cancel();
      }}
      onBlur={(e) => void commit((e.target as HTMLInputElement).value)}
    />
  ) : (
    <>
      <span class="set-rail-group-name">{deviceLabel || "此设备"}</span>
      <button
        class="set-rail-group-edit"
        title="重命名本机"
        onClick={() => {
          closed.current = false;
          setEditing(true);
        }}
      >
        <Icon name="pencil" />
      </button>
    </>
  );
}

/** Left rail (wide shells only — see useShellNarrow): two labelled groups from
 *  GROUPS. The device group's header is the renamable device name; the
 *  workspace group's header is static. The single accent bar slides to the
 *  active row — active is the current page, no scroll-spy. */
function SettingsNav({ page }: { page: PageId }) {
  const navRef = useRef<HTMLElement>(null);

  // Slide the single accent bar to the active row via CSS vars; CSS transitions
  // it. Re-place on any nav resize — the device label loading or the rename
  // input swapping in shifts every row's offset.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const place = () => {
      const row = nav.querySelector<HTMLElement>(`.set-rail-row[data-sec="${page}"]`);
      if (!row) return;
      nav.style.setProperty("--mark-y", `${row.offsetTop}px`);
      nav.style.setProperty("--mark-h", `${row.offsetHeight}px`);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [page]);

  return (
    <div class="set-rail-col">
      <nav class="set-rail" ref={navRef} aria-label="设置">
        <span class="set-rail-mark" />
        {GROUPS.map((g) => {
          const pages = g.pages.filter((p) => p.show());
          if (pages.length === 0) return null;
          return (
            <div class="set-rail-group" key={g.key}>
              <div class="set-rail-group-head">
                {g.key === "device" ? <DeviceGroupName /> : <span class="set-rail-group-name">工作区</span>}
              </div>
              {pages.map((p) => (
                <button
                  key={p.id}
                  data-sec={p.id}
                  class={"set-rail-row" + (p.id === page ? " active" : "")}
                  aria-current={p.id === page ? "page" : undefined}
                  onClick={() => gotoPage(p.id)}
                >
                  <span class="set-rail-ico"><Icon name={p.icon} /></span>
                  <span class="set-rail-label">{p.label}</span>
                </button>
              ))}
            </div>
          );
        })}
      </nav>
    </div>
  );
}

/** Narrow shells, bare #/settings: the two groups as a flat tappable index
 *  (iOS-settings style drill-down). Rows push ?sec=<page>; the opened page's
 *  way back to this index is the topbar breadcrumb's 设置 segment. */
function SettingsIndex() {
  return (
    <nav class="set-index" aria-label="设置">
      {GROUPS.map((g) => {
        const pages = g.pages.filter((p) => p.show());
        if (pages.length === 0) return null;
        return (
          <section class="set-index-group" key={g.key}>
            <div class="set-index-head">
              {g.key === "device" ? <DeviceGroupName /> : <span class="set-rail-group-name">工作区</span>}
            </div>
            {pages.map((p) => (
              <button key={p.id} class="set-index-row" onClick={() => gotoPage(p.id)}>
                <span class="set-index-ico"><Icon name={p.icon} /></span>
                <span class="set-index-label">{p.label}</span>
                <span class="set-index-chev"><Icon name="chevron" /></span>
              </button>
            ))}
          </section>
        );
      })}
    </nav>
  );
}

/** The 外观 page: theme grid + word count row (old blocks unchanged). */
function AppearanceSettings() {
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme());
  const [wordCount, setWordCountState] = useState<boolean>(getWordCountEnabled());

  const pick = (t: ThemeChoice) => {
    setTheme(t);
    setThemeState(t);
  };

  const toggleWordCount = (on: boolean) => {
    setWordCountEnabled(on);
    setWordCountState(on);
  };

  return (
    <>
      <PageHeader title={pageLabel("appearance")} />
      <SetSection label="颜色主题">
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
      </SetSection>
      <SetSection label="文档">
        <SetRow
          title="字数统计"
          caption="在文档右下角显示字数，悬停查看字符数与预计阅读时间。"
          control={<Switch checked={wordCount} onChange={toggleWordCount} />}
        />
      </SetSection>
    </>
  );
}

export function SettingsView({ onUpdatePending, focusSec }: { onUpdatePending?: (p: boolean) => void; focusSec?: string } = {}) {
  // Fully URL-driven page selection (#/settings?sec=<page>); legacy sec values
  // from old deep links map via nav.ts LEGACY_SEC.
  const [shellRef, narrow] = useShellNarrow();
  const page = resolvePage(focusSec);
  // Bare #/settings: wide shells show the first visible page (rail marks it);
  // narrow shells show the drill-down index instead. Resizing across the
  // breakpoint swaps index ⇄ first page without touching the URL — deliberate.
  const showIndex = narrow && focusSec === undefined;

  // .content keeps its scroll position across hash changes — reset per page.
  // window.scrollTo covers the mobile document-scroll mode (.content is
  // overflow:visible there).
  useEffect(() => {
    shellRef.current?.closest(".content")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }, [page, showIndex]);

  return (
    <div class={"set-shell" + (narrow ? " narrow" : "")} ref={shellRef}>
      <div class="set-page">
        {!narrow && <SettingsNav page={page} />}
        <div class="set-main">
          {showIndex ? (
            <>
              <PageHeader title="设置" />
              <SettingsIndex />
            </>
          ) : (
            <>
              {page === "appearance" && <AppearanceSettings />}

              {page === "quicknote" && <QuickNotesSettings />}

              {page === "offline" && <OfflinePage />}

              {/* The cloud bucket that keeps every device in sync (doc 19). It
                  lives on the server (origin) or this device (no-origin); shown
                  in either mode so its ownership is never hidden. */}
              {page === "backup" && <BackupPage />}

              {/* Device management only makes sense against a server (origin) —
                  the page is hidden (nav.ts show()) and resolvePage never lands
                  here in a no-origin shell. */}
              {page === "devices" && <DevicesPanel />}

              {page === "hosting" && <SiteHostingSettings />}
            </>
          )}

          <VersionFooter onUpdatePending={onUpdatePending} />
        </div>
      </div>
    </div>
  );
}

function SiteHostingSettings() {
  const noOrigin = isNoOrigin();
  const [base, setBase] = useState("");
  const [savedBase, setSavedBase] = useState<string | null>(null);
  const [scope, setScope] = useState<string | null>(null);
  const [edge, setEdge] = useState<EdgeStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [ownerToken, setOwnerToken] = useState("");

  const load = () => {
    api.getEdgeStatus().then(setEdge).catch(() => setEdge(null));
    if (!noOrigin)
      api
        .getSiteHosting()
        .then((v) => {
          setSavedBase(v.publicBaseUrl);
          setBase(v.publicBaseUrl ?? "");
          setScope(v.scope);
        })
        .catch(() => undefined);
  };
  useEffect(load, []);

  const saveBase = async () => {
    setBusy("base");
    try {
      const out = await api.setSiteHosting(base.trim() || null);
      setSavedBase(out.publicBaseUrl);
      setBase(out.publicBaseUrl ?? "");
      setScope(out.scope);
      toast(out.publicBaseUrl ? "入口验证成功并已保存" : "已清除设备托管入口");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const connect = async () => {
    setBusy("connect");
    try {
      const out = await api.connectEdge(endpoint, ownerToken);
      setEdge(out);
      setOwnerToken("");
      const failed = out.wired?.filter((x) => !x.registered) ?? [];
      const notes = [
        ...(out.warnings ?? []),
        ...(failed.length
          ? [`${failed.length} 个站点重新接线失败：${failed.map((x) => x.site).join("、")}`]
          : []),
      ];
      toast(
        notes.length ? `已连接 Edge；${notes.join("；")}` : "已连接 Edge",
      );
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const disconnect = async () => {
    const ok = await confirmDialog({
      title: "断开 Edge？",
      message: "只移除本机连接，不会删除 Cloudflare Worker 或 D1。存在活动 Room 时会拒绝断开。",
      confirmLabel: "断开",
      danger: true,
    });
    if (!ok) return;
    setBusy("disconnect");
    try {
      await api.disconnectEdge();
      load();
      toast("已断开 Edge");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const edgeStatusText = !edge?.configured
    ? null
    : !edge.reachable
      ? "不可达"
      : edge.aligned
        ? "在线"
        : "需升级";

  return (
    <>
      <PageHeader title={pageLabel("hosting")} />
      {!noOrigin && (
        <SetSection label="设备托管入口">
          <SetRow
            title="公网入口地址"
            caption={
              savedBase
                ? `已验证 · ${scope === "public" ? "公网 HTTPS" : scope === "lan" ? "局域网" : "仅本机"}`
                : "填写已由反向代理、隧道或公网 IP 转发到本节点的地址；保存时会访问 /health 并核对节点身份。"
            }
            control={
              <>
                <input
                  class="text-input set-row-input"
                  value={base}
                  placeholder="https://site.example.com"
                  onInput={(e) => setBase((e.currentTarget as HTMLInputElement).value)}
                />
                <button class="btn btn-secondary" disabled={busy === "base"} onClick={saveBase}>
                  {busy === "base" ? "验证中…" : "验证并保存"}
                </button>
              </>
            }
          />
          {isDesktop() && (
            <div class="set-callout warn">
              Desktop 内置 sidecar 只监听本机且关闭鉴权，不能直接暴露到公网。需要设备托管时请另行启动带鉴权的
              <code> mh --server</code>，或使用下方 Edge。
            </div>
          )}
        </SetSection>
      )}

      <SetSection label="Edge 始终在线托管">
        <div class="set-managed-note">
          {noOrigin
            ? "此设备把数据存放在云端存储桶、不常驻在线，站点需由 Edge 托管。你的设备离线期间，Edge 继续提供最后一次同步的版本。"
            : "Edge Room 不依赖设备在线。可一键部署到你的 Cloudflare 账户，或连接已有兼容端点。"}
        </div>
        {edge?.configured ? (
          <>
            <SetRow
              title="端点"
              caption={edge.endpoint}
              control={
                !noOrigin && edge.managed ? (
                  <button
                    class="btn btn-secondary"
                    onClick={() => openModal(<EdgeDeployModal status={edge} onDone={() => { closeModal(); load(); }} />)}
                  >
                    升级部署…
                  </button>
                ) : undefined
              }
            />
            <SetRow
              title="状态"
              caption={
                `${edgeStatusText} · 版本 ${edge.version ?? "未知"} / ${edge.expectedVersion} · 活动 Room ${edge.rooms.length} · ` +
                (edge.rooms.length === 0
                  ? "暂无 Room"
                  : edge.rooms.some((room) => room.error || room.status === "error")
                    ? "Room 同步存在异常"
                    : edge.rooms.some((room) => room.lastSuccessAt)
                      ? `Room 最近同步 ${timeAgo(Math.max(...edge.rooms.map((room) => room.lastSuccessAt ?? 0)))}`
                      : "等待首次同步") +
                (edge.error ? ` · ${edge.error}` : "")
              }
            />
          </>
        ) : (
          <>
            <SetRow
              title="部署到 Cloudflare"
              caption="在你自己的账户创建 Worker + D1（可顺带创建 R2 同步桶），断开时不会自动删除。"
              control={
                !noOrigin ? (
                  <button
                    class="btn btn-primary"
                    onClick={() => openModal(<EdgeDeployModal status={edge} onDone={() => { closeModal(); load(); }} />)}
                  >
                    一键部署…
                  </button>
                ) : undefined
              }
            />
            <SetRow
              title="连接已有 Edge"
              caption="任意兼容 /v1/inbox 协议的端点。"
              control={
                <>
                  <input
                    class="text-input set-row-input"
                    value={endpoint}
                    placeholder="https://…workers.dev"
                    onInput={(e) => setEndpoint((e.currentTarget as HTMLInputElement).value)}
                  />
                  <input
                    class="text-input set-row-input"
                    type="password"
                    value={ownerToken}
                    placeholder="Owner token"
                    onInput={(e) => setOwnerToken((e.currentTarget as HTMLInputElement).value)}
                  />
                  <button class="btn btn-secondary" disabled={busy === "connect"} onClick={connect}>
                    {busy === "connect" ? "连接中…" : "连接"}
                  </button>
                </>
              }
            />
          </>
        )}
      </SetSection>

      {edge?.configured && (
        <DangerZone>
          <SetRow
            danger
            title="断开 Edge"
            caption="只移除本机连接，不会删除 Cloudflare Worker 或 D1；存在活动 Room 时会拒绝断开。"
            control={
              <button class="btn btn-ghost device-danger" disabled={busy === "disconnect"} onClick={disconnect}>
                断开
              </button>
            }
          />
        </DangerZone>
      )}
    </>
  );
}

// ---- blob cache (document images / large files) ----------------------------

/** One-line workspace data-map summary heading 数据与备份: how many places hold
 *  the data, how fresh, anything not yet backed up. Same core derivation as
 *  `mh status` — the api selector picks the server (window) or this replica
 *  (full node) per clientMode, never a bespoke fork here. Rendered as a quiet
 *  sub-line under the page title (no callout box) — the dot alone carries the
 *  tone; 详情 expands flat hairline per-place rows. */
function SyncHealthLine() {
  const [map, setMap] = useState<DataMap | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    const tick = () => api.syncHealth().then((m) => live && setMap(m)).catch(() => undefined);
    tick();
    const t = setInterval(tick, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (!map) return null;
  const tone = dataMapTone(map);
  return (
    <div class="sync-health">
      <button class="sync-health-line" onClick={() => setOpen((o) => !o)}>
        <span class={`sync-health-dot dot-${tone}`} />
        <span class="sync-health-text">{dataMapHeadline(map)}</span>
        <span class="sync-health-more">详情</span>
        <span class={`row-chev${open ? " open" : ""}`}>
          <Icon name="chevronDown" />
        </span>
      </button>
      {open && (
        <div class="sync-health-places">
          {map.places.map((p) => (
            <div class="sync-health-place" key={p.url ?? "self"}>
              <span class="sync-health-place-kind">{PLACE_KIND_LABEL[p.kind]}</span>
              <span class="sync-health-place-label">{p.label}</span>
              <span class="sync-health-place-cap">{placeCaption(p)}</span>
              {p.roles.includes("blob_anchor") && (
                <span class="sync-health-role">{PLACE_ROLE_LABEL.blob_anchor}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 数据与备份 — the workspace page. Health banner on top (same derivation as
 * `mh status`), then ONE row per sync bucket — a bucket's only home in the UI:
 * status in the caption, every action (sync / direct-connect / key rotation /
 * recovery code / remove) in the row's ⋯ menu. Below, the long-term blob
 * anchors (workspace policy). Empty state = the connect-Cloudflare CTA.
 * Data/ownership rules are unchanged from the old SyncStorage (doc 19): origin
 * buckets live on the server and are mirrored read-only here; a trusted replica
 * may re-enter the secret to sync one directly; no-origin owns its own list.
 */
function BackupPage() {
  const noOrigin = isNoOrigin();
  const desktop = isDesktop();
  // The workspace's blob store scope (云端工作区 / desktop 本机工作区). Absent
  // exactly in no-origin cells — those keep bytes only in the browser replica.
  const serverScope = scopesFor(clientMode()).find((s) => s.kind === "server");
  const [enabled, setEnabled] = useState(replicaEnabled());
  const [serverPeers, setServerPeers] = useState<S3Peer[] | null>(null);
  const [localPeers, setLocalPeers] = useState<StoragePeerView[] | null>(null);
  const [edge, setEdge] = useState<EdgeStatus | null>(null);

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
      api.getEdgeStatus().then(setEdge).catch(() => setEdge(null));
    }
  };
  useEffect(() => {
    reload();
    return onReplicaStatus(() => {
      setEnabled(replicaEnabled());
      reloadLocal();
    });
  }, []);

  const localUrls = new Set((localPeers ?? []).map((p) => p.url));
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
  const rotateBucket = (p: S3Peer) =>
    openModal(<RotateModal buckets={[p]} onDone={() => { closeModal(); reload(); }} />);
  const recoveryBucket = (p: S3Peer) => openModal(<RecoveryCodeModal buckets={[p]} />);

  const syncBucket = async (url: string) => {
    try {
      if (noOrigin) await replicaCall("sync");
      else {
        await api.syncPeer(url);
        if (replicaOn && localUrls.has(url)) await replicaCall("sync").catch(() => {});
      }
      toast("已触发同步");
      reload();
    } catch (e) {
      toast(`同步失败：${(e as Error).message}`);
    }
  };

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
      if (replicaOn) await replicaCall("removeStorageReplica", url).catch(() => {});
    }
    reload();
  };

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

  const getConfig = (peerUrl: string): Promise<S3Config | null> =>
    noOrigin
      ? replicaCall<S3Config | null>("storagePeerConfig", peerUrl)
      : api.serverS3Config(peerUrl);
  const bucketList = ((noOrigin ? localPeers : serverPeers) ?? []).map((pr) => ({
    url: pr.url,
    name: pr.label || pr.bucket || pr.url,
  }));
  // no-origin only — the devices page is hidden there, so onboarding another
  // device lives on this page permanently (origin/desktop: 设备 page).
  const addDevice = () =>
    openModal(
      <AddDeviceModal
        buckets={bucketList}
        getConfig={getConfig}
        server={!noOrigin}
        onPaired={() => {
          closeModal();
          reload();
        }}
      />,
    );

  const list = noOrigin ? localPeers : serverPeers;
  const rowCaption = (p: { endpoint?: string | null; lastSyncAt: number | null; status: string | null; error: string | null }, extra?: string) =>
    [
      p.endpoint ? hostOf(p.endpoint) : null,
      `上次同步 ${fmtTime(p.lastSyncAt)}`,
      extra ?? null,
      p.status === "error" && p.error ? `同步失败：${p.error}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

  // no-origin without a replica: nothing can hold the bucket peer yet.
  if (noOrigin && !enabled) {
    return (
      <>
        <PageHeader title={pageLabel("backup")} banner={<SyncHealthLine />} />
        <div class="set-callout warn" style={{ marginTop: 12 }}>
          先在「离线与缓存」把这台设备设为在本机保存，再连接存储桶。{" "}
          <a href="#/settings?sec=offline">前往设置</a>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title={pageLabel("backup")} banner={<SyncHealthLine />} />

      <SetSection
        label="同步存储桶"
        caption={!noOrigin && !desktop ? "此配置属于整个工作区，保存在服务器上。" : undefined}
      >
        {list == null ? (
          <div class="muted">加载中…</div>
        ) : list.length === 0 ? (
          !noOrigin && edge != null && !edge.configured ? (
            <div class="cloud-cta">
              <div class="cloud-cta-text">
                <div class="cloud-cta-title">连接 Cloudflare</div>
                <div class="cloud-cta-sub">
                  一次登录，同时开通云端备份（R2 同步桶，免费 10GB）与始终在线入口（Edge）。数据全程端到端加密，云端只见密文。
                </div>
              </div>
              <button
                class="btn btn-primary"
                onClick={() =>
                  openModal(
                    <EdgeDeployModal
                      status={edge}
                      presetR2
                      onDone={() => {
                        closeModal();
                        reload();
                      }}
                    />,
                  )
                }
              >
                连接 Cloudflare
              </button>
              <div class="cloud-cta-alt muted">
                用其他 S3 服务商？<a href="#" onClick={(e) => { e.preventDefault(); add(); }}>连接存储桶</a> 手动填入即可。
              </div>
            </div>
          ) : (
            <SetRow
              title="还没连接存储桶"
              caption="连一个云端存储桶，所有设备就能保持同步——内容端到端加密。"
              control={<button class="btn btn-primary" onClick={add}>连接存储桶</button>}
            />
          )
        ) : (
          <>
            {list.map((p) => {
              const name = p.label || p.bucket || p.url;
              const onDevice = !noOrigin && replicaOn && localUrls.has(p.url);
              const sp = p as S3Peer;
              return (
                <SetRow
                  key={p.url}
                  title={name}
                  caption={rowCaption(
                    p,
                    noOrigin ? "本机发布" : onDevice ? "本机已直连" : undefined,
                  )}
                  control={
                    <RowMenu
                      items={[
                        { icon: "cloudUp", label: "立即同步", onClick: () => void syncBucket(p.url) },
                        ...(!noOrigin && replicaOn && !onDevice
                          ? [{ icon: "link", label: "在本设备直连", sublabel: "服务器不可达时也能同步", onClick: () => activateHere(sp) }]
                          : []),
                        ...(onDevice
                          ? [{ icon: "link", label: "取消本设备直连", onClick: () => void detachHere(p.url, name) }]
                          : []),
                        ...(!noOrigin
                          ? [
                              { icon: "lock", label: "轮换存储密钥…", sublabel: "手机丢了 / 密钥泄露时", onClick: () => rotateBucket(sp) },
                              { icon: "copy", label: "导出恢复码…", onClick: () => recoveryBucket(sp) },
                            ]
                          : []),
                        { icon: "trash", label: "移除存储桶", danger: true, onClick: () => void removeBucket(p.url, name) },
                      ]}
                    />
                  }
                />
              );
            })}
            <div class="set-row-tail">
              <button class="btn btn-ghost" onClick={add}>连接另一个存储桶</button>
              {noOrigin && bucketList.length > 0 && (
                <button class="btn btn-ghost" onClick={addDevice}>添加设备</button>
              )}
            </div>
          </>
        )}
      </SetSection>

      {serverScope && <WorkspaceStorageSection scope={serverScope} />}

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
    </>
  );
}

/** 附件存储 — the workspace blob store in ONE section: the byte hero (stats /
 *  clear / manage), the anchor policy that gates clearing, and the single
 *  备份核对 row. Placement = scope (doc 19): this section IS the server /
 *  desktop-workspace bytes; 离线与缓存 only ever touches browser bytes. The
 *  location caption comes from the scope projection, never hardcoded copy. */
function WorkspaceStorageSection({ scope }: { scope: Scope }) {
  const [info, setInfo] = useState<BlobCacheInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const load = () => api.blobCache().then(setInfo).catch(() => undefined);
  const verify = async (manual = false) => {
    setVerifying(true);
    try {
      setInfo(await api.verifyBlobCache());
    } catch (e) {
      if (manual) toast((e as Error).message);
    } finally {
      setVerifying(false);
    }
  };
  useEffect(() => {
    load(); // paint fast from last-known…
    void verify(); // …then confirm anchor presence
  }, []);

  const stats = info?.stats;
  const clearable = stats?.clearableBytes ?? 0;
  const hasFreeable = clearable > 0;
  const noAnchor = info != null && info.policy.fullNodes.length === 0;
  const selfNode = info?.nodes.find((n) => n.self);
  const selfIsFull = !!selfNode && !!info && info.policy.fullNodes.includes(selfNode.nodeId);
  const unverified = !!info && !noAnchor && !selfIsFull && info.lastVerifiedAt == null;
  const ringState: RingState = selfIsFull
    ? "self-full"
    : noAnchor
      ? "no-anchor"
      : unverified
        ? "unverified"
        : hasFreeable
          ? "free"
          : "safe";

  const clear = async () => {
    const ok = await confirmDialog({
      title: "清理腾空间",
      message: `将释放约 ${fmtBytes(clearable)}。只删别处已备份的副本，文件不会丢，用到时自动取回。`,
      confirmLabel: "清理",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.clearBlobCache();
      toast(r.cleared ? `已腾出 ${fmtBytes(r.freedBytes)}（${r.cleared} 项）` : "暂时没有可清理的");
      load(); // clearing doesn't invalidate lastVerifiedAt — no re-verify
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveFull = async (ids: string[]) => {
    setBusy(true);
    try {
      await api.setBlobPolicy({ full_nodes: ids });
      await verify();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggleNode = (id: string) => {
    if (!info) return;
    const set = new Set(info.policy.fullNodes);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    void saveFull([...set]);
  };
  const pickRedundancy = async (r: "all" | "any") => {
    setBusy(true);
    try {
      await api.setBlobPolicy({ redundancy: r });
      await verify();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (info == null || stats == null) {
    return (
      <SetSection label="附件存储" caption={`存放在「${scope.label}」（${scope.subtitle}），全部设备共用。`}>
        <SetRow title="缓存占用" caption="加载中…" />
      </SetSection>
    );
  }

  const { policy, nodes, buckets } = info;
  const bucketAnchors = [
    ...buckets,
    ...policy.fullNodes
      .filter((a) => a.startsWith("s3://") && !buckets.some((b) => b.url === a))
      .map((url) => ({ url, label: null, bucket: null })),
  ];

  return (
    <SetSection label="附件存储" caption={`存放在「${scope.label}」（${scope.subtitle}），全部设备共用。`}>
      <CacheRingHero
        segs={{
          free: stats.clearableBytes,
          keep: Math.max(0, stats.retainedBytes - info.pinnedBytes),
          pin: info.pinnedBytes,
        }}
        count={stats.count}
        totalBytes={stats.totalBytes}
        state={ringState}
        verifying={verifying}
        actions={
          <>
            <button class="btn btn-secondary" disabled={busy || verifying || !hasFreeable} onClick={() => void clear()}>
              {hasFreeable ? `清理腾出 ${fmtBytes(clearable)}` : "无需清理"}
            </button>
            <button class="btn btn-ghost" onClick={() => openBlobManager(scope)}>
              管理
            </button>
          </>
        }
      />
      {unverified && !verifying && (
        <div class="set-managed-note">尚未核对备份——点下方「重新检查」核对后可清理。</div>
      )}
      {nodes.map((n) => {
        const on = policy.fullNodes.includes(n.nodeId);
        return (
          <SetRow
            key={n.nodeId}
            title={(n.label || n.nodeId) + (n.self ? " · 本机" : "")}
            caption={on ? "正在长期保存全部附件副本" : "开启后长期保存全部附件副本"}
            control={<Switch checked={on} disabled={busy} onChange={() => toggleNode(n.nodeId)} />}
          />
        );
      })}
      {bucketAnchors.map((b) => {
        const on = policy.fullNodes.includes(b.url);
        return (
          <SetRow
            key={b.url}
            title={(b.label || b.bucket || b.url) + " · 云端"}
            caption={on ? "正在长期保存全部附件副本" : "开启后长期保存全部附件副本"}
            control={<Switch checked={on} disabled={busy} onChange={() => toggleNode(b.url)} />}
          />
        );
      })}
      {policy.fullNodes.length === 0 && (
        <div class="set-managed-note">还没设置长期备份。先指定一处，其他设备才能放心清理本机缓存。</div>
      )}
      {policy.fullNodes.length > 1 && (
        <SetRow
          title="清理前先确认"
          caption="决定各设备清理缓存前，需要几处备份确认持有。"
          control={
            <div class="seg">
              <button
                class={"seg-opt" + (policy.redundancy === "any" ? " on" : "")}
                disabled={busy || verifying}
                onClick={() => void pickRedundancy("any")}
              >
                <span class="seg-opt-t">一处即可</span>
              </button>
              <button
                class={"seg-opt" + (policy.redundancy === "all" ? " on" : "")}
                disabled={busy || verifying}
                onClick={() => void pickRedundancy("all")}
              >
                <span class="seg-opt-t">每处都要</span>
              </button>
            </div>
          }
        />
      )}
      <SetRow
        title="备份核对"
        caption={
          (verifying
            ? "检查中…"
            : info.lastVerifiedAt != null
              ? `${timeAgo(info.lastVerifiedAt)}检查过`
              : "未检查") +
          (info.unreachableAnchors.length > 0 ? " · 部分备份连不上，相关文件暂不清理" : "")
        }
        control={
          <button class="btn btn-ghost" disabled={busy || verifying} onClick={() => void verify(true)}>
            重新检查
          </button>
        }
      />
      {info.quotaBytes > 0 && (
        <div class="set-managed-note">
          缓存超过 {fmtBytes(info.quotaBytes)} 时，自动清理最久没用、已有备份的，你固定的不动。
        </div>
      )}
    </SetSection>
  );
}


// ---- 离线与缓存 (the per-device page) ---------------------------------------

/**
 * 离线与缓存 — the per-device page: one switch for "keep a full offline copy on
 * THIS device", a sync-now row, then STRICTLY this device's browser bytes.
 * Placement = scope: workspace bytes live on 数据与备份 → 附件存储; the page is
 * hidden on desktop (nav.ts), whose sidecar bytes are workspace storage.
 */
function OfflinePage() {
  return (
    <>
      <PageHeader title={pageLabel("offline")} />
      <ReplicaSection cache={<DeviceCacheSlot />} />
    </>
  );
}

/** The replica switch + sync-now row, with the cache section slotted between
 *  the rows and the page-bottom danger zone (they share the busy state). */
function ReplicaSection({ cache }: { cache: ComponentChildren }) {
  const unsupported = replicaUnsupportedReason();
  const noOrigin = isNoOrigin();
  const [enabled, setEnabled] = useState(replicaEnabled());
  const [st, setSt] = useState<ReplicaStatus>(replicaStatus());
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<string | null>(null);

  useEffect(
    () =>
      onReplicaStatus((s) => {
        setSt({ ...s });
        setEnabled(replicaEnabled());
      }),
    [],
  );
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
    // unregister() doesn't un-control the already-loaded page; if a SW was
    // controlling, reload once after teardown so this session lands cleanly in
    // lightweight (no SW intercepting /api/*). The reloaded page is uncontrolled
    // (registration is gone), so this can't loop.
    const hadSw =
      typeof navigator !== "undefined" &&
      "serviceWorker" in navigator &&
      navigator.serviceWorker.controller != null;
    setBusy(true);
    try {
      await disableReplica();
      setEnabled(false);
      toast("已停用离线副本");
      if (hadSw) location.reload();
    } finally {
      setBusy(false);
    }
  };

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

  const statusLine = () => {
    if (!enabled) return "开启后断网也能读写全部内容，改动自动同步。";
    if (st.state === "error") return `副本异常（已自动回退在线模式）：${st.error ?? "未知错误"}`;
    if (st.state === "hydrating") return `正在下载数据… 已接收 ${st.hydrated ?? 0} 条变更`;
    if (st.lastSync) {
      const t = fmtTime(st.lastSync.at);
      return st.lastSync.ok
        ? `离线可用 · 上次同步 ${t}（推送 ${st.lastSync.pushed} / 拉取 ${st.lastSync.pulled}）`
        : `上次同步失败（${t}）：${st.lastSync.error ?? ""} — 本地读写不受影响，恢复网络后自动重试`;
    }
    return "等待首次同步…";
  };

  const caption = unsupported
    ? `此设备暂不支持在本机保存：${unsupported}`
    : statusLine() +
      (enabled && st.node ? ` · 节点 ${st.node}` : "") +
      (enabled && usage ? ` · 本地占用 ${usage} MB` : "");

  return (
    <>
      <SetSection label="离线副本">
        <SetRow
          title="在此设备保存离线副本"
          caption={caption}
          control={
            <Switch
              checked={enabled}
              disabled={busy || !!unsupported}
              locked={noOrigin && enabled}
              onChange={(on) => (on ? void enable() : void disable())}
            />
          }
        />
        {enabled && (
          <SetRow
            title="立即同步"
            caption="把本机改动推送出去，并拉取其他设备的最新内容。"
            control={
              <button class="btn btn-secondary" disabled={busy} onClick={() => requestSync()}>
                立即同步
              </button>
            }
          />
        )}
      </SetSection>
      {cache}
      {enabled && (
        <DangerZone>
          <SetRow
            danger
            title="重置本地副本"
            caption="删除此浏览器里的全部本地数据并停用离线副本；未同步的本地修改会丢失。"
            control={
              <button class="btn btn-ghost device-danger" disabled={busy} onClick={reset}>
                重置
              </button>
            }
          />
        </DangerZone>
      )}
    </>
  );
}

/** The device page's cache slot: strictly THIS device's browser bytes. A local
 *  scope exists only when this client holds a replica; otherwise the device
 *  stores nothing clearable, expressed by absence (workspace bytes live on
 *  数据与备份). The onReplicaStatus subscription is required, not decorative:
 *  enabling the replica flips clientMode().hold and the slot must appear
 *  without a reload — OfflinePage itself never re-renders on replica events. */
function DeviceCacheSlot() {
  const [, bump] = useState(0);
  useEffect(() => onReplicaStatus(() => bump((t) => t + 1)), []);
  const local = scopesFor(clientMode()).find((s) => s.kind === "local");
  return local ? <LocalCacheRows scope={local} /> : null;
}

/** Browser-side cache (replica / no-origin): everything unpinned is freeable —
 *  the bucket/server still holds a copy; the pending spool is never touched. */
function LocalCacheRows({ scope }: { scope: Scope }) {
  const [stats, setStats] = useState<{ count: number; totalBytes: number; pinnedBytes: number } | null>(null);
  const [pending, setPending] = useState<{ count: number; bytes: number }>({ count: 0, bytes: 0 });
  const [usage, setUsage] = useState<number | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [s, pend] = await Promise.all([cacheStats(), spoolPending()]);
      setStats(s);
      setPending({ count: pend.length, bytes: pend.reduce((n, e) => n + e.bytes.byteLength, 0) });
    } catch {
      /* IndexedDB unavailable — keep the loading row */
    }
    if (navigator.storage?.estimate) {
      try {
        const e = await navigator.storage.estimate();
        if (e.usage != null) setUsage(e.usage);
      } catch {
        /* estimate unsupported */
      }
    }
    if (navigator.storage?.persisted) {
      try {
        setPersisted(await navigator.storage.persisted());
      } catch {
        /* persisted unsupported */
      }
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const clearable = stats ? Math.max(0, stats.totalBytes - stats.pinnedBytes) : 0;
  const hasFreeable = clearable > 0;

  const clear = async () => {
    const ok = await confirmDialog({
      title: "清理腾空间",
      message: `将释放约 ${fmtBytes(clearable)}。只清本机缓存，文件已存在云端，用到时自动取回。待上传的内容不会动。`,
      confirmLabel: "清理",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await clearCache();
      toast(r.cleared ? `已腾出 ${fmtBytes(r.freedBytes)}（${r.cleared} 项）` : "暂时没有可清理的");
      await load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const requestPersist = async () => {
    if (!navigator.storage?.persist) return;
    setBusy(true);
    try {
      const ok = await navigator.storage.persist();
      setPersisted(ok);
      toast(ok ? "已设为常驻，系统不会自动清理" : "浏览器暂未授予常驻");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SetSection label="本机缓存" caption="只存在这台设备上；清理不影响其他设备，文件用到时自动取回。">
      {pending.count > 0 && (
        <div class="set-callout warn">
          {pending.count} 项（约 {fmtBytes(pending.bytes)}）还没上传，仅存在这台设备上。建议先「立即同步」再清理——清理不会动这些待上传的内容。
        </div>
      )}
      {stats == null ? (
        <SetRow title="缓存占用" caption="加载中…" />
      ) : (
        <CacheRingHero
          segs={{ free: clearable, keep: 0, pin: stats.pinnedBytes }}
          count={stats.count}
          totalBytes={stats.totalBytes}
          state={hasFreeable ? "free" : "safe"}
          actions={
            <>
              <button class="btn btn-secondary" disabled={busy || !hasFreeable} onClick={() => void clear()}>
                {hasFreeable ? `清理腾出 ${fmtBytes(clearable)}` : "无需清理"}
              </button>
              <button class="btn btn-ghost" onClick={() => openBlobManager(scope)}>
                管理
              </button>
            </>
          }
        />
      )}
      <SetRow
        title="常驻存储"
        caption={
          persisted
            ? "已开启：系统空间紧张时不会自动清掉本地数据。"
            : "开启后，系统空间紧张时也不会自动清掉本地数据。"
        }
        control={
          persisted !== true ? (
            <button
              class="btn btn-ghost"
              disabled={busy || !navigator.storage?.persist}
              onClick={() => void requestPersist()}
            >
              请求常驻
            </button>
          ) : undefined
        }
      />
      {usage != null && (
        <div class="set-managed-note">
          此浏览器为本工作区共占用约 {fmtBytes(usage)}（含本地数据库与缓存）。缓存超过 {fmtBytes(BLOB_QUOTA_BYTES)} 时自动清理最久没用、已有备份的，你固定的不动。
        </div>
      )}
    </SetSection>
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
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);

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
    setProgress(null);
    setErrMsg("");
    const off = cu!.onDownloadProgress?.((p) => setProgress(p));
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
    } finally {
      off?.();
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
      case "downloading": {
        const pct =
          progress && progress.total > 0
            ? Math.min(100, Math.round((progress.received / progress.total) * 100))
            : null;
        update = (
          <span class="ver-up ver-dl">
            <span class={`ver-bar${pct == null ? " indet" : ""}`}>
              <span class="ver-bar-fill" style={pct != null ? { width: `${pct}%` } : undefined} />
            </span>
            <span class="ver-num">{pct != null ? `${pct}%` : "下载中…"}</span>
          </span>
        );
        break;
      }
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

  // PWA / bucket-only shell: no desktop bridge (appVer) and no server to answer
  // /api/version (running) — fall back to the build version stamped into the
  // bundle, so the footer is never empty. Fallback only: it stays hidden whenever
  // App or Core is available (desktop, live server).
  const webFallback = !appVer && !running && WEBUI_VERSION;
  return (
    <div class="set-footer">
      {appVer && <span>App <span class="ver-num">{appVer}</span></span>}
      {appVer && running && <span class="set-footer-sep">·</span>}
      {running && <span>Core <span class="ver-num">{running}</span></span>}
      {webFallback && <span class="ver-num">v{WEBUI_VERSION}</span>}
      {update && (running || appVer || webFallback) && <span class="set-footer-sep">·</span>}
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

/** Mac modifier glyphs — rendered a touch larger so they sit level with letters. */
const MOD_GLYPHS = new Set(["⌘", "⌥", "⇧", "⌃"]);

/** Split an accelerator into per-key display tokens, per platform. */
function shortcutTokens(accel: string): string[] {
  const mac = typeof window !== "undefined" && window.metahubDesktop?.platform === "darwin";
  return accel.split("+").map((p) =>
    p === "CommandOrControl" ? (mac ? "⌘" : "Ctrl")
    : p === "Alt" ? (mac ? "⌥" : "Alt")
    : p === "Shift" ? (mac ? "⇧" : "Shift")
    : p,
  );
}

/** Show an accelerator the way users read it, per platform (string form, for toasts). */
function prettyShortcut(accel: string): string {
  const mac = typeof window !== "undefined" && window.metahubDesktop?.platform === "darwin";
  return shortcutTokens(accel).join(mac ? " " : "+");
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
    <>
      <PageHeader title={pageLabel("quicknote")} sub="用全局快捷键随时唤起小窗记录想法。小窗也可从菜单栏图标打开。" />
      <SetSection label="小窗">
        <SetRow
          title="唤起快捷键"
          caption="点击右侧按钮，然后按下你想用的组合键。"
          control={
            <>
              {shortcut !== DEFAULT_SHORTCUT && (
                <button class="btn btn-ghost" title="重置默认" onClick={() => void applyShortcut(DEFAULT_SHORTCUT)}>
                  重置
                </button>
              )}
              <button
                class={"btn btn-secondary qn-shortcut" + (capturing ? " capturing" : "")}
                onClick={() => setCapturing(true)}
                onBlur={() => setCapturing(false)}
                onKeyDown={capturing ? onCaptureKey : undefined}
              >
                {capturing ? "按下组合键…" : (
                  <span class="qn-keys">
                    {shortcutTokens(shortcut).map((k) => (
                      <span class={"qn-key" + (MOD_GLYPHS.has(k) ? " sym" : "")}>{k}</span>
                    ))}
                  </span>
                )}
              </button>
            </>
          }
        />
        <SetRow
          title="默认始终置顶"
          caption="小窗浮在其他窗口之上；也可在小窗内用 📌 按钮切换。"
          control={<Switch checked={alwaysOnTop} onChange={() => void toggleTop()} />}
        />
      </SetSection>
    </>
  );
}

// ---- unified device roster -------------------------------------------------

const DEVICE_CHANNEL_LABEL: Record<string, string> = {
  paired_out: "直连配对",
  grant_in: "已授权接入",
  oplog: "存储桶或历史同步",
};

/** One list for every device touching the workspace (core sync/devices.ts):
 *  how each joined, last activity, and the honest way to cut it off. Replaces
 *  the old separate 同步设备 + 已授权设备 blocks; per-channel actions (sync /
 *  enable / remove / revoke) live in each row's expandable detail. */
function DevicesPanel() {
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [buckets, setBuckets] = useState<S3Peer[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const reload = () => {
    api.listDevices().then(setDevices).catch((e) => toast(`加载失败：${e.message}`));
    api.listPeers().then(setPeers).catch(() => undefined);
    api.listServerS3Peers().then(setBuckets).catch(() => undefined);
  };
  useEffect(() => {
    reload();
  }, []);

  const syncNow = async (url: string) => {
    try {
      const r = await api.syncPeer(url);
      toast(r.ok ? `已同步：推送 ${r.pushed}，拉取 ${r.pulled}` : `同步失败：${r.error}`);
    } catch (e) {
      toast(`同步失败：${(e as Error).message}`);
    }
    reload();
  };
  const togglePeer = async (url: string) => {
    const p = peers.find((x) => x.url === url);
    await api.updatePeer(url, { enabled: !(p?.enabled ?? 0) }).catch((e) => toast(e.message));
    reload();
  };
  const removePeerRow = async (url: string) => {
    const ok = await confirmDialog({
      title: "移除同步设备",
      message: `确定移除 ${url}？将停止与该设备的数据同步。它此前已同步的数据仍留在该设备上，无法远程删除。`,
      confirmLabel: "移除",
      danger: true,
    });
    if (!ok) return;
    await api.removePeer(url).catch((e) => toast(e.message));
    reload();
  };
  const revokeGrantRef = async (prefix: string, deviceName: string) => {
    const ok = await confirmDialog({
      title: "吊销接入凭据",
      message: `吊销后，${deviceName} 将无法再同步进本机。它此前已同步的数据仍留在该设备上，无法远程删除。`,
      confirmLabel: "吊销",
      danger: true,
    });
    if (!ok) return;
    await api.revokeGrant(prefix).catch((e) => toast(e.message));
    reload();
  };

  const deviceName = (d: DeviceView) => d.label ?? d.nodeId ?? "(未知设备)";

  // Onboard another device (QR / enroll code / HTTP pairing). This page is
  // origin-only, so the enroll config comes from the server's bucket list.
  const addDevice = () =>
    openModal(
      <AddDeviceModal
        buckets={buckets.map((b) => ({ url: b.url, name: b.label || b.bucket || b.url }))}
        getConfig={(url) => api.serverS3Config(url)}
        server
        onPaired={() => {
          closeModal();
          reload();
        }}
      />,
    );

  return (
    <>
      <PageHeader
        title={pageLabel("devices")}
        sub="所有接触这个工作区的设备，以及断开它们的方式。"
        action={
          <button class="btn btn-primary" onClick={addDevice}>
            添加设备
          </button>
        }
      />
      <SetSection label="设备">
        {devices == null ? (
          <div class="muted">加载中…</div>
        ) : devices.length === 0 ? (
          <div class="muted">还没有其他设备。</div>
        ) : (
          devices.map((d) => {
            const key = d.nodeId ?? `grant:${d.channels[0]?.ref ?? ""}`;
            const expanded = open === key;
            return (
              <SetRow
                key={key}
                title={
                  <>
                    {deviceName(d)}
                    {d.self && <span class="set-row-tag">本机</span>}
                  </>
                }
                caption={
                  ([...new Set(d.channels.map((c) => DEVICE_CHANNEL_LABEL[c.kind]))].join(" · ") || "—") +
                  " · 最近活动 " +
                  (d.lastActivityAt ? timeAgo(d.lastActivityAt) : "未知") +
                  (!d.self && d.revocable === "bucket_rotate" ? " · 共用存储钥匙" : "")
                }
                onClick={() => setOpen(expanded ? null : key)}
                control={
                  <span class={`row-chev${expanded ? " open" : ""}`}>
                    <Icon name="chevronDown" />
                  </span>
                }
              >
                {expanded && (
                  <div class="device-detail">
                    {d.nodeId && <div class="device-detail-line muted">节点 ID：{d.nodeId}</div>}
                    {d.channels.map((c, i) => (
                      <div key={i} class="device-detail-line">
                        <span class="device-ch-label">{DEVICE_CHANNEL_LABEL[c.kind]}</span>
                        <span class="device-ch-ref">{c.kind === "grant_in" ? `${c.ref}…` : c.ref}</span>
                        <span class="muted">{c.lastSeenAt ? fmtTime(c.lastSeenAt) : ""}</span>
                        {c.kind === "paired_out" && (
                          <span class="device-ch-actions">
                            <button class="btn btn-ghost" onClick={() => syncNow(c.ref)}>立即同步</button>
                            <button class="btn btn-ghost" onClick={() => togglePeer(c.ref)}>
                              {peers.find((x) => x.url === c.ref)?.enabled ? "禁用" : "启用"}
                            </button>
                            <button class="btn btn-ghost device-danger" onClick={() => removePeerRow(c.ref)}>移除</button>
                          </span>
                        )}
                        {c.kind === "grant_in" && !d.self && (
                          <span class="device-ch-actions">
                            <button class="btn btn-ghost device-danger" onClick={() => revokeGrantRef(c.ref, deviceName(d))}>吊销</button>
                          </span>
                        )}
                      </div>
                    ))}
                    {!d.self && d.revocable === "bucket_rotate" && (
                      <div class="device-detail-note">
                        通过云端存储同步的设备共用同一把存储钥匙，无法单独移除。要让丢失的设备失去访问：先在存储服务商停用旧钥匙，再到「数据与备份」该桶的菜单里选「轮换存储密钥」。<b>它已下载的数据无法追回。</b>
                      </div>
                    )}
                  </div>
                )}
              </SetRow>
            );
          })
        )}
      </SetSection>
    </>
  );
}
