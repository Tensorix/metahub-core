/** @jsxImportSource preact */
import type { ComponentChild, ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import type { S3Config } from "../core/sync/storage.ts";
import { encodeEnroll } from "../core/sync/enroll.ts";
import { Icon, CUBE_OUTER, CUBE_INNER } from "./icons.tsx";
import { getTheme, setTheme, type ThemeChoice } from "./theme.ts";
import { getWordCountEnabled, setWordCountEnabled } from "./wordcount.ts";
import { timeAgo } from "./date.ts";
import {
  api,
  currentToken,
  type Peer,
  type Grant,
  type S3Peer,
  type BlobCacheInfo,
  type EdgeStatus,
  type ShareTargetOpt,
} from "./api.ts";
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
import { ScopeSelector } from "./scope-selector.tsx";
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
const isDesktop = () => clientMode().surface === "desktop";

const THEMES: { value: ThemeChoice; icon: string; name: string; desc: string }[] = [
  { value: "light", icon: "sun", name: "浅色", desc: "始终使用明亮界面" },
  { value: "dark", icon: "moon", name: "深色", desc: "始终使用暗色界面" },
  { value: "system", icon: "monitor", name: "跟随系统", desc: "随操作系统外观自动切换" },
];

/** A titled gray panel that groups related settings blocks. The page is white;
 *  the panel is a subtle gray surface so the white widget cards inside read as
 *  raised insets (macOS System Settings / Notion grouped-list feel). Children
 *  are `.set-block`s, hairline-divided by CSS. `id` doubles as the scroll anchor
 *  the left quick-jump rail (SettingsRail) targets. */
function SetGroup({ id, label, children }: { id?: string; label: string; children: ComponentChildren }) {
  return (
    <div class="set-group" id={id}>
      <div class="set-group-label">{label}</div>
      <div class="set-panel">{children}</div>
    </div>
  );
}

/** Single source of truth for the settings chapters: drives BOTH the left
 *  quick-jump rail and the `id` anchors on each `SetGroup`, so the two can never
 *  drift. `show()` mirrors the exact render conditions in `SettingsView`. */
const SEC = {
  appearance: "appearance",
  quicknote: "quicknote",
  sync: "sync",
  hosting: "hosting",
  storage: "storage",
  devices: "devices",
} as const;

const SECTIONS: { id: string; label: string; icon: string; show: () => boolean }[] = [
  { id: SEC.appearance, label: "外观", icon: "sun", show: () => true },
  { id: SEC.quicknote, label: "快速笔记", icon: "pin",
    show: () => typeof window !== "undefined" && !!window.metahubDesktop?.quicknote },
  { id: SEC.sync, label: "同步", icon: "cloudCheck", show: () => true },
  { id: SEC.hosting, label: "站点托管", icon: "globe", show: () => true },
  { id: SEC.storage, label: "存储", icon: "database", show: () => true },
  { id: SEC.devices, label: "设备与授权", icon: "monitor", show: () => !isNoOrigin() },
];

/** Floating quick-jump rail in the centred column's left gutter (wide screens
 *  only — gated by a container query in CSS). One labelled row per visible
 *  chapter; a scroll-spy highlights the chapter in view and a single accent bar
 *  slides to it. Mirrors the proven scroll-spy in editor.tsx's DocToc. */
function SettingsRail({ sections }: { sections: { id: string; label: string; icon: string }[] }) {
  const [activeId, setActiveId] = useState(sections[0]?.id ?? "");
  const navRef = useRef<HTMLElement>(null);
  // Honour a click's selection while its smooth scroll is in flight, so the
  // scroll-spy doesn't yank the highlight mid-travel (timestamp = ignore-until).
  const lockRef = useRef(0);
  const idsKey = sections.map((s) => s.id).join("|");

  useEffect(() => {
    const scroller = document.querySelector(".content");
    let raf = 0;
    // Active = the last chapter whose top has scrolled above a line just below
    // the topbar. Cheap to read rects for a handful of sections on each scroll.
    const compute = () => {
      if (Date.now() < lockRef.current) return; // a click owns the highlight for now
      // Bottom clamp: a short page can't scroll the last chapter's top up to the
      // line, so it'd never light up — force it active once we hit the bottom.
      const atBottom = scroller
        ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
        : window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      if (atBottom) { setActiveId(sections[sections.length - 1]!.id); return; }
      const line = Math.max(scroller ? scroller.getBoundingClientRect().top : 0, 0) + 72;
      let active = sections[0]!.id;
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top - line <= 1) active = s.id;
        else break;
      }
      setActiveId(active);
    };
    const onScroll = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; compute(); }); };
    compute();
    const obs = new IntersectionObserver(compute, {
      root: scroller as Element | null,
      rootMargin: "-72px 0px -70% 0px",
      threshold: [0, 1],
    });
    for (const s of sections) { const el = document.getElementById(s.id); if (el) obs.observe(el); }
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true }); // mobile: document scrolls
    return () => {
      obs.disconnect();
      scroller?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [idsKey]);

  // Slide the single accent bar to the active row via CSS vars; CSS transitions it.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const row = nav.querySelector<HTMLElement>(`.set-rail-row[data-sec="${activeId}"]`);
    if (!row) return;
    nav.style.setProperty("--mark-y", `${row.offsetTop}px`);
    nav.style.setProperty("--mark-h", `${row.offsetHeight}px`);
  }, [activeId, idsKey]);

  const jump = (id: string) => {
    lockRef.current = Date.now() + 600; // ~smooth-scroll duration
    setActiveId(id); // optimistic: highlight the clicked row at once (incl. the last)
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div class="set-rail-slot">
      <nav class="set-rail" ref={navRef} aria-label="设置区块">
        <span class="set-rail-mark" />
        {sections.map((s) => (
          <button
            key={s.id}
            data-sec={s.id}
            class={"set-rail-row" + (s.id === activeId ? " active" : "")}
            aria-current={s.id === activeId ? "true" : undefined}
            onClick={() => jump(s.id)}
          >
            <span class="set-rail-ico"><Icon name={s.icon} /></span>
            <span class="set-rail-label">{s.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

export function SettingsView({ onUpdatePending, focusSec }: { onUpdatePending?: (p: boolean) => void; focusSec?: string } = {}) {
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme());
  const [wordCount, setWordCountState] = useState<boolean>(getWordCountEnabled());

  // Deep link from elsewhere in the app (#/settings?sec=hosting): jump to the
  // requested chapter once mounted — sections render synchronously, so a rAF is
  // enough for layout to settle before the scroll.
  useEffect(() => {
    if (!focusSec) return;
    const raf = requestAnimationFrame(() =>
      document.getElementById(focusSec)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
    return () => cancelAnimationFrame(raf);
  }, [focusSec]);

  const pick = (t: ThemeChoice) => {
    setTheme(t);
    setThemeState(t);
  };

  const toggleWordCount = (on: boolean) => {
    setWordCountEnabled(on);
    setWordCountState(on);
  };

  const visibleSections = SECTIONS.filter((s) => s.show());

  return (
    <div class="set-shell">
      <div class="set-page">
        {visibleSections.length >= 2 && <SettingsRail sections={visibleSections} />}
        <div class="set-title">设置</div>
        <div class="set-sub">个性化你的 Metahub 工作区。</div>

        <SetGroup id={SEC.appearance} label="外观">
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
          <div class="set-block">
            <div class="set-toggle-row">
              <div class="set-toggle-text">
                <div class="set-block-head"><span class="set-block-title">字数统计</span></div>
                <div class="set-block-desc">在文档右下角显示字数，悬停查看字符数与预计阅读时间。</div>
              </div>
              <label class="set-switch">
                <input
                  type="checkbox"
                  checked={wordCount}
                  onChange={(e) => toggleWordCount((e.currentTarget as HTMLInputElement).checked)}
                />
                <span class="set-switch-track"><span class="set-switch-thumb" /></span>
              </label>
            </div>
          </div>
        </SetGroup>

        {typeof window !== "undefined" && window.metahubDesktop?.quicknote && (
          <SetGroup id={SEC.quicknote} label="快速笔记"><QuickNotesSettings /></SetGroup>
        )}

        {/* One "同步" chapter (doc 19): how THIS device uses the workspace
            (lightweight / trusted), then the cloud bucket that keeps every device
            in sync. The bucket lives on the server (origin) or this device
            (no-origin); shown in either mode so its ownership is never hidden. */}
        <SetGroup id={SEC.sync} label="同步">
          {!isDesktop() && <DeviceSetup />}
          <SyncStorage />
        </SetGroup>

        <SetGroup id={SEC.hosting} label="站点托管">
          <SiteHostingSettings />
        </SetGroup>

        {/* Blob cache (document images / large files). Which store the user is
            managing falls out of scopesFor(clientMode()): a server-backed replica
            sees BOTH its on-device bytes (default) and the cloud workspace ledger,
            instead of the old isNoOrigin() fork that silently only ever showed one. */}
        <SetGroup id={SEC.storage} label="存储">
          <StoragePanel />
        </SetGroup>

        {/* HTTP pairing + issued grants only make sense against a server (origin). */}
        {!isNoOrigin() && (
          <SetGroup id={SEC.devices} label="设备与授权">
            <SyncDevices />
            <IssuedGrants />
          </SetGroup>
        )}

        <VersionFooter onUpdatePending={onUpdatePending} />
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
  const [devices, setDevices] = useState<ShareTargetOpt[]>([]);
  const [busy, setBusy] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [ownerToken, setOwnerToken] = useState("");

  const load = () => {
    api.getEdgeStatus().then(setEdge).catch(() => setEdge(null));
    api.listShareServers().then(setDevices).catch(() => setDevices([]));
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

  return (
    <>
      {!noOrigin && (
        <div class="set-block">
          <div class="set-block-head">
            <span class="set-block-title">设备托管入口</span>
            {savedBase && (
              <span class="set-badge ok">
                {scope === "public" ? "公网 HTTPS" : scope === "lan" ? "局域网" : "仅本机"}
              </span>
            )}
          </div>
          <div class="set-block-desc">
            填写已经由反向代理、隧道或公网 IP 转发到本节点的地址。保存时会访问
            <code> /health</code> 并核对节点身份。
          </div>
          <div class="set-inline" style={{ marginTop: 10 }}>
            <input
              class="text-input"
              style={{ flex: 1 }}
              value={base}
              placeholder="https://site.example.com"
              onInput={(e) => setBase((e.currentTarget as HTMLInputElement).value)}
            />
            <button class="btn btn-primary" disabled={busy === "base"} onClick={saveBase}>
              {busy === "base" ? "验证中…" : "验证并保存"}
            </button>
          </div>
          {isDesktop() && (
            <div class="set-callout warn" style={{ marginTop: 10 }}>
              Desktop 内置 sidecar 只监听本机且关闭鉴权，不能直接暴露到公网。需要设备托管时请另行启动带鉴权的
              <code> mh --server</code>，或使用下方 Edge。
            </div>
          )}
          <div class="set-block-head" style={{ marginTop: 14 }}>
            <span class="set-block-title">配对设备</span>
            <span class="muted">{devices.length} 台</span>
          </div>
          {devices.length === 0 ? (
            <div class="set-block-desc">暂无配对设备；发布时仍可使用当前设备或 Edge。</div>
          ) : (
            devices.map((device) => (
              <div class="set-kv">
                <span>
                  {device.label}
                  <small class="muted" style={{ display: "block" }}>{device.url}</small>
                </span>
                <span
                  class={
                    "set-badge " +
                    (device.enabled !== false && device.lastStatus === "ok" ? "ok" : "warn")
                  }
                >
                  {device.enabled === false
                    ? "已停用"
                    : device.lastStatus === "ok"
                      ? "可用"
                      : device.lastStatus
                        ? "异常"
                        : "未验证"}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      <div class="set-block">
        <div class="set-block-head">
          <span class="set-block-title">Edge 始终在线托管</span>
          {edge?.configured && (
            <span class={"set-badge " + (edge.reachable && edge.aligned ? "ok" : "warn")}>
              {edge.reachable ? (edge.aligned ? "在线" : "需升级") : "不可达"}
            </span>
          )}
        </div>
        <div class="set-block-desc">
          {noOrigin
            ? "此设备把数据存放在云端存储桶、不常驻在线，站点需由 Edge 托管。你的设备离线期间，Edge 继续提供最后一次同步的版本。"
            : "Edge Room 不依赖设备在线。可一键部署到你的 Cloudflare 账户，或连接已有兼容端点。"}
        </div>

        {edge?.configured ? (
          <div style={{ marginTop: 10 }}>
            <div class="set-kv"><span>端点</span><code>{edge.endpoint}</code></div>
            <div class="set-kv">
              <span>版本</span>
              <code>{edge.version ?? "未知"} / {edge.expectedVersion}</code>
            </div>
            <div class="set-kv"><span>活动 Room</span><b>{edge.rooms.length}</b></div>
            <div class="set-kv">
              <span>Room 同步</span>
              <span>
                {edge.rooms.length === 0
                  ? "暂无 Room"
                  : edge.rooms.some((room) => room.error || room.status === "error")
                    ? "存在异常"
                    : edge.rooms.some((room) => room.lastSuccessAt)
                      ? `最近 ${timeAgo(
                          Math.max(
                            ...edge.rooms.map((room) => room.lastSuccessAt ?? 0),
                          ),
                        )}`
                      : "等待首次同步"}
              </span>
            </div>
            {edge.error && <div class="set-err">{edge.error}</div>}
            <div class="set-actions" style={{ marginTop: 10 }}>
              {!noOrigin && edge.managed && (
                <button
                  class="btn btn-secondary"
                  onClick={() => openModal(<EdgeDeployModal status={edge} onDone={() => { closeModal(); load(); }} />)}
                >
                  升级部署…
                </button>
              )}
              <button class="btn btn-danger" disabled={busy === "disconnect"} onClick={disconnect}>
                断开
              </button>
            </div>
          </div>
        ) : (
          <>
            <div class="set-inline" style={{ marginTop: 10 }}>
              <input
                class="text-input"
                style={{ flex: 1 }}
                value={endpoint}
                placeholder="https://…workers.dev"
                onInput={(e) => setEndpoint((e.currentTarget as HTMLInputElement).value)}
              />
              <input
                class="text-input"
                style={{ flex: 1 }}
                type="password"
                value={ownerToken}
                placeholder="Owner token"
                onInput={(e) => setOwnerToken((e.currentTarget as HTMLInputElement).value)}
              />
              <button class="btn btn-secondary" disabled={busy === "connect"} onClick={connect}>
                {busy === "connect" ? "连接中…" : "连接已有 Edge"}
              </button>
            </div>
            {!noOrigin && (
              <div style={{ marginTop: 10 }}>
                <button
                  class="btn btn-primary"
                  onClick={() => openModal(<EdgeDeployModal status={edge} onDone={() => { closeModal(); load(); }} />)}
                >
                  一键部署到 Cloudflare…
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function EdgeDeployModal({
  status,
  onDone,
}: {
  status: EdgeStatus | null;
  onDone: () => void;
}) {
  const defaults = status?.defaults;
  const oauthAvailable = status?.oauthConfigured ?? false;
  // Default to OAuth when available; the API-token inputs stay as an explicit
  // fallback (e.g. OAuth not registered on this build, or the user prefers it).
  const [useToken, setUseToken] = useState(!oauthAvailable);
  const [accountId, setAccountId] = useState(
    status?.pending?.accountId ?? status?.deployment?.accountId ?? "",
  );
  const [apiToken, setApiToken] = useState("");
  // OAuth flow state.
  const [authState, setAuthState] = useState<"idle" | "authing" | "ready" | "error">("idle");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [authErr, setAuthErr] = useState("");
  const [workerName, setWorkerName] = useState(
    status?.pending?.workerName ??
      status?.deployment?.workerName ??
      defaults?.workerName ??
      "",
  );
  const [d1Name, setD1Name] = useState(
    status?.pending?.d1Name ??
      status?.deployment?.d1Name ??
      defaults?.d1Name ??
      "",
  );
  const [subdomain, setSubdomain] = useState(
    status?.pending?.workersSubdomain ??
      status?.deployment?.workersSubdomain ??
      defaults?.workersSubdomain ??
      "",
  );
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  // Poll the OAuth flow until the redirect is caught + accounts discovered.
  useEffect(() => {
    if (authState !== "authing" || !flowId) return;
    let live = true;
    const timer = setInterval(async () => {
      try {
        const s = await api.edgeOAuthStatus(flowId);
        if (!live) return;
        if (s.state === "ready") {
          setAccounts(s.accounts ?? []);
          if ((s.accounts ?? []).length === 1) setAccountId(s.accounts![0]!.id);
          setAuthState("ready");
        } else if (s.state === "error") {
          setAuthErr(s.error || "Cloudflare 授权失败");
          setAuthState("error");
        }
      } catch (e) {
        if (!live) return;
        setAuthErr((e as Error).message);
        setAuthState("error");
      }
    }, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [authState, flowId]);

  // Tear down an unconsumed flow if the modal unmounts mid-auth.
  useEffect(
    () => () => {
      if (flowId && authState !== "idle") api.cancelEdgeOAuth(flowId).catch(() => {});
    },
    [flowId, authState],
  );

  const signIn = async () => {
    setAuthErr("");
    try {
      const { flowId: id, authUrl } = await api.beginEdgeOAuth();
      setFlowId(id);
      setAuthState("authing");
      // In the desktop app the consent page must open in the real browser (the
      // loopback redirect is caught by the sidecar); in a plain browser a tab is fine.
      if (window.metahubDesktop?.oauth) window.metahubDesktop.oauth.openExternal(authUrl);
      else window.open(authUrl, "_blank", "noopener");
    } catch (e) {
      setAuthErr((e as Error).message);
      setAuthState("error");
    }
  };

  const deploy = async () => {
    if (!confirmed) return toast("请先确认将创建或更新列出的 Cloudflare 资源");
    if (!useToken && authState !== "ready") return toast("请先用 Cloudflare 登录");
    if (!useToken && accounts.length > 1 && !accountId) return toast("请选择要部署到的 Cloudflare 账号");
    setBusy(true);
    try {
      const result = await api.deployEdge(
        useToken
          ? { accountId, apiToken, workerName, d1Name, workersSubdomain: subdomain, confirmed }
          : {
              flowId: flowId!,
              accountId: accountId || undefined,
              workerName,
              d1Name,
              workersSubdomain: subdomain,
              confirmed,
            },
      );
      setApiToken("");
      // The flow's token was consumed server-side; forget it locally.
      setFlowId(null);
      setAuthState("idle");
      const failed = result.wired.filter((x) => !x.registered);
      const notes = [
        ...result.warnings,
        ...(failed.length ? [`${failed.length} 个站点重新接线失败：${failed.map((x) => x.site).join("、")}`] : []),
      ];
      toast(notes.length ? `Edge 部署完成；${notes.join("；")}` : "Edge 部署完成");
      onDone();
    } catch (e) {
      setApiToken("");
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={status?.configured ? "升级 Edge" : "部署 Edge"}
      sub="将在你自己的 Cloudflare 账户中创建或更新一个 Worker、一个 D1 数据库和 workers.dev 入口。凭据仅用于本次请求，不会保存。"
      footer={
        <>
          <button
            class="btn btn-secondary"
            onClick={() => {
              if (flowId && authState !== "idle") api.cancelEdgeOAuth(flowId).catch(() => {});
              closeModal();
            }}
          >
            取消
          </button>
          <button
            class="btn btn-primary"
            disabled={busy || !confirmed || (!useToken && authState !== "ready")}
            onClick={deploy}
          >
            {busy ? "部署中…" : "确认并部署"}
          </button>
        </>
      }
    >
      {!useToken ? (
        <>
          <div class="field-label">Cloudflare 账号</div>
          {authState === "ready" ? (
            accounts.length > 1 ? (
              <select
                class="text-input"
                value={accountId}
                onChange={(e) => setAccountId((e.currentTarget as HTMLSelectElement).value)}
              >
                <option value="">选择账号…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}（{a.id}）
                  </option>
                ))}
              </select>
            ) : (
              <div class="muted" style={{ fontSize: 13 }}>
                ✅ 已登录：{accounts[0]?.name ?? accountId}
              </div>
            )
          ) : (
            <button class="btn btn-secondary" disabled={authState === "authing"} onClick={signIn}>
              {authState === "authing" ? "等待浏览器授权…" : "用 Cloudflare 登录"}
            </button>
          )}
          <div class="muted" style={{ fontSize: 12, marginTop: 6 }}>
            将打开 Cloudflare 授权页，只申请 Workers 与 D1 的最小权限；令牌仅用于本次部署、不会保存。
            {oauthAvailable && (
              <>
                {" "}
                <a href="#" onClick={(e) => { e.preventDefault(); setUseToken(true); }}>
                  改用 API Token
                </a>
              </>
            )}
          </div>
          {authErr && (
            <div class="muted" style={{ fontSize: 12, marginTop: 4, color: "var(--danger, #c0392b)" }}>
              {authErr}
            </div>
          )}
        </>
      ) : (
        <>
          <div class="field-label">Cloudflare Account ID</div>
          <input class="text-input" value={accountId} onInput={(e) => setAccountId((e.currentTarget as HTMLInputElement).value)} />
          <div class="field-label">临时 API Token</div>
          <input class="text-input" type="password" value={apiToken} onInput={(e) => setApiToken((e.currentTarget as HTMLInputElement).value)} />
          <div class="muted" style={{ fontSize: 12, marginTop: 4 }}>
            需要 Workers Scripts Write 与 D1 Write。Cloudflare Token 是账户级凭据，请仅使用最小权限 Token。
            {oauthAvailable && (
              <>
                {" "}
                <a href="#" onClick={(e) => { e.preventDefault(); setUseToken(false); }}>
                  改用 Cloudflare 登录
                </a>
              </>
            )}
          </div>
        </>
      )}
      <div class="field-label">Worker 名称</div>
      <input class="text-input" value={workerName} onInput={(e) => setWorkerName((e.currentTarget as HTMLInputElement).value)} />
      <div class="field-label">D1 名称</div>
      <input class="text-input" value={d1Name} onInput={(e) => setD1Name((e.currentTarget as HTMLInputElement).value)} />
      <div class="field-label">workers.dev 子域（账户尚未设置时创建）</div>
      <input class="text-input" value={subdomain} onInput={(e) => setSubdomain((e.currentTarget as HTMLInputElement).value)} />
      <div class="muted" style={{ fontSize: 12, marginTop: 4 }}>
        子域属于整个 Cloudflare 账户；如果账户已有子域，将使用现有值并在完成结果中提示。
      </div>
      {status?.pending && (
        <div class="set-callout warn" style={{ marginTop: 10 }}>
          检测到未完成部署，当前步骤：{status.pending.step}。使用相同名称可继续，不会自动删除已创建资源。
        </div>
      )}
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12 }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed((e.currentTarget as HTMLInputElement).checked)} />
        <span>我确认创建或更新上述 Cloudflare 资源；断开 MetaHub 时不会自动删除它们。</span>
      </label>
    </Modal>
  );
}

// ---- blob cache (document images / large files) ----------------------------

/** The 存储 panel. A Notion-style scope picker on top (本机 / 云端工作区), then the
 *  byte-management body for the selected scope. Replaces the old binary
 *  `isNoOrigin() ? Local : Blob` fork (doc 19): the scope SET falls out of
 *  scopesFor(clientMode()) with buckets filtered (a bucket is a backend of the
 *  data home, not a byte-management scope). A server-backed replica now lands on
 *  its own on-device bytes by default and can switch to the cloud ledger; single-
 *  scope clients (thin / no-origin / desktop) just see a read-only scope pill. */
function StoragePanel() {
  const scopes = scopesFor(clientMode()).filter((s) => s.kind !== "bucket");
  const [sel, setSel] = useState<string>(scopes[0]?.id ?? "server");
  const active = scopes.find((s) => s.id === sel) ?? scopes[0]!;
  const choice = scopes.length > 1;
  return (
    <>
      <div class="set-block">
        {choice && (
          <div class="set-block-head">
            <span class="set-block-title">管理哪里的存储</span>
          </div>
        )}
        <ScopeSelector scopes={scopes} value={active.id} onChange={setSel} sub={choice} />
      </div>
      {active.kind === "local" ? <LocalCacheSettings scope={active} /> : <BlobCacheSettings scope={active} />}
    </>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** A verify older than this (or never) makes an over-quota cache "stuck" — surfaced
 *  so "over quota but not evicting" reads as offline/stale, not a broken quota. */
const VERIFY_STALE_MS = 5 * 60 * 1000;

const prefersReduced = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Smoothly counts the displayed byte figure from its previous value to the new
 *  target whenever it changes (easeOutCubic, ~600ms). Honours reduced-motion. */
function useCountUp(target: number, ms = 600): number {
  const [val, setVal] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (prefersReduced()) {
      from.current = target;
      setVal(target);
      return;
    }
    const start = from.current;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(start + (target - start) * e));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return val;
}

/**
 * Storage panel: the local blob cache (document images / large files) + the
 * clear policy. A blob is clearable only once a designated "full blob device"
 * durably holds it — the reference stays, bytes re-download on demand. Server-
 * backed only (a no-origin replica keeps blobs in browser Cache Storage).
 */
function BlobCacheSettings({ scope }: { scope: Scope }) {
  const [info, setInfo] = useState<BlobCacheInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const load = () => {
    api
      .blobCache()
      .then((i) => {
        setInfo(i);
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message));
  };
  // Re-check, right now, which cached blobs the designated anchors actually hold
  // (bucket LIST / device /api/blobs/has) and record the per-blob verdict clearing
  // reads. Runs in the background on panel open + on the manual refresh button.
  const verify = async (manual = false) => {
    setVerifying(true);
    try {
      setInfo(await api.verifyBlobCache());
      setErr(null);
    } catch (e) {
      if (manual) toast((e as Error).message); // background failures stay quiet
    } finally {
      setVerifying(false);
    }
  };
  useEffect(() => {
    load(); // show last-known instantly…
    void verify(); // …then confirm presence against the anchors
  }, []);

  // `drawn` flips on after mount so the ring arcs animate from 0 → their share.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(r);
  }, []);
  // Count-up for the ring centre figure. Called unconditionally (hook rules) —
  // 0 while the panel is still loading.
  const count = useCountUp(info?.stats.clearableBytes ?? 0);

  if (err || !info) {
    return (
      <div class="set-block">
        <div class="set-block-head"><span class="set-block-title">本机存储</span></div>
        <div class="set-block-desc">{err ? `无法读取缓存信息：${err}` : "加载中…"}</div>
      </div>
    );
  }

  const { stats, policy, nodes, buckets, quotaBytes, pinnedBytes } = info;

  // Bucket anchors to show: locally-attached buckets, plus any s3:// anchor already
  // in the synced policy this device hasn't configured locally — still surface it as
  // a (checked) anchor so the user sees a full copy is designated.
  const bucketAnchors = [
    ...buckets,
    ...policy.fullNodes
      .filter((a) => a.startsWith("s3://") && !buckets.some((b) => b.url === a))
      .map((url) => ({ url, label: null, bucket: null })),
  ];

  const saveFull = async (ids: string[]) => {
    setBusy(true);
    try {
      await api.setBlobPolicy({ full_nodes: ids });
      await verify(); // anchor set changed → server reset verdicts; re-check presence
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggleNode = (id: string) => {
    const set = new Set(policy.fullNodes);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    void saveFull([...set]);
  };
  const pickRedundancy = async (r: "all" | "any") => {
    setBusy(true);
    try {
      await api.setBlobPolicy({ redundancy: r });
      await verify(); // any/all changed → re-check which blobs now qualify
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    const ok = await confirmDialog({
      title: "清理腾空间",
      message: `将释放约 ${fmtBytes(stats.clearableBytes)}。只删别处已备份的副本，文件不会丢，用到时自动取回。`,
      confirmLabel: "清理",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.clearBlobCache();
      toast(r.cleared ? `已腾出 ${fmtBytes(r.freedBytes)}（${r.cleared} 项）` : "暂时没有可清理的");
      load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Three ring segments (their bytes sum to total; pinned ⊆ retained):
  //   freeable  = clearable bytes (the space you can reclaim)   → accent
  //   retained  = held-but-not-pinned                           → neutral grey
  //   pinned    = bytes you locked from eviction                → muted, thinner
  const total = Math.max(1, stats.totalBytes);
  const retainedFree = Math.max(0, stats.retainedBytes - pinnedBytes);
  const pct = (v: number) => (v / total) * 100;
  const segClear = pct(stats.clearableBytes);
  const segRetain = pct(retainedFree);
  const segPin = pct(pinnedBytes);
  const hasFreeable = stats.clearableBytes > 0;
  // Ring centre mirrors the core clear judgment (blobs-core isClearable): no anchor
  // → nothing clearable; this device IS the full library → keeps everything; an
  // anchor designated but never verified → unknown until a refresh confirms it.
  const noAnchor = policy.fullNodes.length === 0;
  const selfNode = nodes.find((n) => n.self);
  const selfIsFull = !!selfNode && policy.fullNodes.includes(selfNode.nodeId);
  const unverified = !noAnchor && !selfIsFull && info.lastVerifiedAt == null;
  const ringState = selfIsFull
    ? "self-full"
    : noAnchor
      ? "no-anchor"
      : unverified
        ? "unverified"
        : hasFreeable
          ? "free"
          : "safe";
  const verifyStale = info.lastVerifiedAt == null || Date.now() - info.lastVerifiedAt > VERIFY_STALE_MS;
  // Over quota but the sweep evicted nothing because presence couldn't be confirmed
  // (anchor offline / verdict stale) — surface so it doesn't read as a broken quota.
  const overQuotaStuck =
    quotaBytes > 0 &&
    stats.totalBytes > quotaBytes &&
    (info.unreachableAnchors.length > 0 || verifyStale);

  // Stroke is sized in pathLength=100 units so segment lengths read as percent.
  // `drawn` flips on after mount so the arcs animate from 0 → their share.
  const arc = (len: number) => (drawn ? len : 0);

  return (
    <div class="set-block blob-pane">
      <div class="set-block-head"><span class="set-block-title">本机存储</span></div>
      <div class="set-block-desc">
        图片和大文件会先存在这台设备上，打开快。只要别处留了一份长期备份，这里随时能清——文件不会丢，需要时自动取回。
      </div>

      <div class="blob-hero">
        <div class="blob-hero-main">
          <div class="blob-legend">
            <div class="blob-legend-row">
              <span class="blob-dot free" /> <span class="blob-legend-k">可释放</span>
              <b>{fmtBytes(stats.clearableBytes)}</b>
            </div>
            <div class="blob-legend-row">
              <span class="blob-dot keep" /> <span class="blob-legend-k">保留中</span>
              <b>{fmtBytes(retainedFree)}</b>
            </div>
            {pinnedBytes > 0 && (
              <div class="blob-legend-row">
                <span class="blob-dot pin" /> <span class="blob-legend-k">已固定</span>
                <b>{fmtBytes(pinnedBytes)}</b>
              </div>
            )}
          </div>
          <div class="blob-total">共 {stats.count} 项 · {fmtBytes(stats.totalBytes)}</div>
          <div class="blob-actions">
            <button
              class="btn btn-secondary blob-clear"
              disabled={busy || verifying || !hasFreeable}
              onClick={() => void clear()}
            >
              <Icon name="trash" cls="ico sm" />
              {hasFreeable ? `清理腾出 ${fmtBytes(stats.clearableBytes)}` : "无需清理"}
            </button>
            <button
              class="btn btn-ghost blob-verify-btn"
              disabled={busy || verifying}
              onClick={() => void verify(true)}
            >
              <Icon name="history" cls={"ico sm" + (verifying ? " spin" : "")} />
              {verifying ? "检查中…" : "重新检查"}
            </button>
            <button class="btn btn-ghost blob-manage-btn" onClick={() => openBlobManager(scope)}>
              <Icon name="filter" cls="ico sm" />
              Blob 管理
            </button>
          </div>
          <div class="blob-verify-at">
            {verifying
              ? ""
              : info.lastVerifiedAt != null
                ? `${timeAgo(info.lastVerifiedAt)}检查过`
                : "未检查"}
          </div>
        </div>

        <div
          class={
            "blob-ring" +
            (ringState === "free" ? " has-free" : ringState === "safe" ? " all-safe" : " locked")
          }
        >
          <svg viewBox="0 0 100 100" class="blob-ring-svg" aria-hidden="true">
            <g transform="rotate(-90 50 50)">
              <circle class="blob-ring-track" cx="50" cy="50" r="42" pathLength={100} />
              {segPin > 0 && (
                <circle
                  class="blob-seg pin"
                  cx="50"
                  cy="50"
                  r="42"
                  pathLength={100}
                  stroke-dasharray={`${arc(segPin)} ${100 - arc(segPin)}`}
                  stroke-dashoffset={-(segClear + segRetain)}
                />
              )}
              <circle
                class="blob-seg keep"
                cx="50"
                cy="50"
                r="42"
                pathLength={100}
                stroke-dasharray={`${arc(segRetain)} ${100 - arc(segRetain)}`}
                stroke-dashoffset={-segClear}
              />
              <circle
                class="blob-seg free"
                cx="50"
                cy="50"
                r="42"
                pathLength={100}
                stroke-dasharray={`${arc(segClear)} ${100 - arc(segClear)}`}
                stroke-dashoffset={0}
              />
            </g>
          </svg>
          <div class="blob-ring-center">
            {ringState === "free" && (
              <>
                <div class="blob-ring-big">{fmtBytes(count)}</div>
                <div class="blob-ring-cap">可释放</div>
              </>
            )}
            {ringState === "safe" && (
              <>
                <div class="blob-ring-check"><Icon name="check" cls="ico" /></div>
                <div class="blob-ring-cap strong">都备份好了</div>
                <div class="blob-ring-cap">暂时无需清理</div>
              </>
            )}
            {ringState === "no-anchor" && (
              <>
                <div class="blob-ring-lock"><Icon name="lock" cls="ico" /></div>
                <div class="blob-ring-cap strong">未设置长期备份</div>
                <div class="blob-ring-cap">指定后才能清理</div>
              </>
            )}
            {ringState === "unverified" && (
              <>
                <div class="blob-ring-lock"><Icon name="history" cls={"ico" + (verifying ? " spin" : "")} /></div>
                <div class="blob-ring-cap strong">{verifying ? "检查中…" : "未检查"}</div>
                <div class="blob-ring-cap">检查后才知道</div>
              </>
            )}
            {ringState === "self-full" && (
              <>
                <div class="blob-ring-lock"><Icon name="database" cls="ico" /></div>
                <div class="blob-ring-cap strong">本机长期备份库</div>
                <div class="blob-ring-cap">保留全部副本</div>
              </>
            )}
          </div>
        </div>
      </div>

      <div class="blob-anchors">
        <div class="blob-sub-title">长期备份保存在</div>
        {nodes.map((n) => {
          const on = policy.fullNodes.includes(n.nodeId);
          return (
            <div class="blob-anchor-row" key={n.nodeId}>
              <span class="blob-anchor-ico"><Icon name="monitor" cls="ico sm" /></span>
              <div class="blob-anchor-main">
                <div class="blob-anchor-name">
                  {n.label || n.nodeId}{n.self ? " · 本机" : ""}
                </div>
                <div class="blob-anchor-sub">{on ? "正在长期保存全部副本" : "开启后保存全部副本"}</div>
              </div>
              <button
                class={"switch" + (on ? " on" : "")}
                role="switch"
                aria-checked={on}
                disabled={busy}
                onClick={() => toggleNode(n.nodeId)}
              >
                <span class="switch-knob" />
              </button>
            </div>
          );
        })}
        {bucketAnchors.map((b) => {
          const on = policy.fullNodes.includes(b.url);
          return (
            <div class="blob-anchor-row" key={b.url}>
              <span class="blob-anchor-ico"><Icon name="database" cls="ico sm" /></span>
              <div class="blob-anchor-main">
                <div class="blob-anchor-name">
                  {b.label || b.bucket || b.url} · 云端
                </div>
                <div class="blob-anchor-sub">{on ? "正在长期保存全部副本" : "开启后保存全部副本"}</div>
              </div>
              <button
                class={"switch" + (on ? " on" : "")}
                role="switch"
                aria-checked={on}
                disabled={busy}
                onClick={() => toggleNode(b.url)}
              >
                <span class="switch-knob" />
              </button>
            </div>
          );
        })}

        {noAnchor && (
          <div class="blob-hint">还没设置长期备份。先指定一处，之后就能放心清理这台设备。</div>
        )}

        {policy.fullNodes.length > 1 && (
          <div class="blob-strategy">
            <div class="blob-sub-title">清理前先确认</div>
            <div class="seg">
              <button
                class={"seg-opt" + (policy.redundancy === "any" ? " on" : "")}
                disabled={busy || verifying}
                onClick={() => void pickRedundancy("any")}
              >
                <span class="seg-opt-t">有一处备份就行</span>
                <span class="seg-opt-s">更省空间</span>
              </button>
              <button
                class={"seg-opt" + (policy.redundancy === "all" ? " on" : "")}
                disabled={busy || verifying}
                onClick={() => void pickRedundancy("all")}
              >
                <span class="seg-opt-t">每处都备份好</span>
                <span class="seg-opt-s">更稳妥</span>
              </button>
            </div>
          </div>
        )}

        {info.unreachableAnchors.length > 0 && (
          <div class="blob-hint warn">部分长期备份连不上，相关文件暂不清理。</div>
        )}
        {overQuotaStuck && (
          <div class="blob-hint warn">空间超了，但备份暂时离线，先没清理。</div>
        )}

        {quotaBytes > 0 && (
          <div class="blob-foot">
            缓存超过 {fmtBytes(quotaBytes)} 时，自动清理最久没用、已有备份的，你固定的不动。
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Storage panel for a no-origin shell (bucket-only). There is no server ledger
 * or anchor model here: the cloud bucket IS the durable home, and `mh-blob-v1`
 * (browser Cache Storage) is purely a local read cache whose bytes re-download
 * on demand. So every unpinned cached byte is freeable; the only bytes that are
 * NOT safe to drop are the pending spool (composed offline, not yet uploaded),
 * which `clearCache` never touches — surfaced here as a "待上传" caution instead.
 */
function LocalCacheSettings({ scope }: { scope: Scope }) {
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
      /* IndexedDB unavailable — fall through to the loading card */
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

  // `drawn` flips on after mount so the ring arcs animate from 0 → their share.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(r);
  }, []);

  // Everything unpinned in the read cache is freeable (the bucket still holds it).
  const clearable = stats ? Math.max(0, stats.totalBytes - stats.pinnedBytes) : 0;
  const count = useCountUp(clearable); // hook rules: call unconditionally

  if (!stats) {
    return (
      <div class="set-block">
        <div class="set-block-head"><span class="set-block-title">本机存储</span></div>
        <div class="set-block-desc">加载中…</div>
      </div>
    );
  }

  const clear = async () => {
    const ok = await confirmDialog({
      title: "清理腾空间",
      message: `将释放约 ${fmtBytes(clearable)}。只清本机缓存，文件已存在云桶，用到时自动取回。待上传的内容不会动。`,
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

  // Ring: freeable (accent) + pinned (muted), summing to the cache total.
  const total = Math.max(1, stats.totalBytes);
  const pct = (v: number) => (v / total) * 100;
  const segClear = pct(clearable);
  const segPin = pct(stats.pinnedBytes);
  const arc = (len: number) => (drawn ? len : 0);
  const hasFreeable = clearable > 0;
  const ringState = hasFreeable ? "free" : "safe";

  return (
    <div class="set-block blob-pane">
      <div class="set-block-head"><span class="set-block-title">本机存储</span></div>
      <div class="set-block-desc">
        图片和大文件会先缓存在这台设备上，打开快。云桶里始终有一份，所以这里随时能清——文件不会丢，需要时自动取回。
      </div>

      <div class="blob-hero">
        <div class="blob-hero-main">
          <div class="blob-legend">
            <div class="blob-legend-row">
              <span class="blob-dot free" /> <span class="blob-legend-k">可释放</span>
              <b>{fmtBytes(clearable)}</b>
            </div>
            {stats.pinnedBytes > 0 && (
              <div class="blob-legend-row">
                <span class="blob-dot pin" /> <span class="blob-legend-k">已固定</span>
                <b>{fmtBytes(stats.pinnedBytes)}</b>
              </div>
            )}
          </div>
          <div class="blob-total">共 {stats.count} 项 · {fmtBytes(stats.totalBytes)}</div>
          <div class="blob-actions">
            <button
              class="btn btn-secondary blob-clear"
              disabled={busy || !hasFreeable}
              onClick={() => void clear()}
            >
              <Icon name="trash" cls="ico sm" />
              {hasFreeable ? `清理腾出 ${fmtBytes(clearable)}` : "无需清理"}
            </button>
            <button class="btn btn-ghost blob-manage-btn" onClick={() => openBlobManager(scope)}>
              <Icon name="filter" cls="ico sm" />
              Blob 管理
            </button>
          </div>
        </div>

        <div class={"blob-ring" + (ringState === "free" ? " has-free" : " all-safe")}>
          <svg viewBox="0 0 100 100" class="blob-ring-svg" aria-hidden="true">
            <g transform="rotate(-90 50 50)">
              <circle class="blob-ring-track" cx="50" cy="50" r="42" pathLength={100} />
              {segPin > 0 && (
                <circle
                  class="blob-seg pin"
                  cx="50"
                  cy="50"
                  r="42"
                  pathLength={100}
                  stroke-dasharray={`${arc(segPin)} ${100 - arc(segPin)}`}
                  stroke-dashoffset={-segClear}
                />
              )}
              <circle
                class="blob-seg free"
                cx="50"
                cy="50"
                r="42"
                pathLength={100}
                stroke-dasharray={`${arc(segClear)} ${100 - arc(segClear)}`}
                stroke-dashoffset={0}
              />
            </g>
          </svg>
          <div class="blob-ring-center">
            {ringState === "free" ? (
              <>
                <div class="blob-ring-big">{fmtBytes(count)}</div>
                <div class="blob-ring-cap">可释放</div>
              </>
            ) : (
              <>
                <div class="blob-ring-check"><Icon name="check" cls="ico" /></div>
                <div class="blob-ring-cap strong">已是最省</div>
                <div class="blob-ring-cap">暂无缓存可清</div>
              </>
            )}
          </div>
        </div>
      </div>

      <div class="blob-anchors">
        {pending.count > 0 && (
          <div class="blob-hint warn">
            {pending.count} 项（约 {fmtBytes(pending.bytes)}）还没上传到云桶，仅存在这台设备上。建议先「立即同步」再清理——清理不会动这些待上传的内容。
          </div>
        )}

        <div class="blob-anchor-row">
          <span class="blob-anchor-ico"><Icon name="lock" cls="ico sm" /></span>
          <div class="blob-anchor-main">
            <div class="blob-anchor-name">常驻存储{persisted == null ? "" : persisted ? " · 已开启" : " · 未开启"}</div>
            <div class="blob-anchor-sub">
              {persisted
                ? "系统空间紧张时不会自动清掉本地数据。"
                : "开启后，系统空间紧张时也不会自动清掉本地数据。"}
            </div>
          </div>
          {persisted !== true && (
            <button class="btn btn-ghost" disabled={busy || !navigator.storage?.persist} onClick={() => void requestPersist()}>
              请求常驻
            </button>
          )}
        </div>

        {usage != null && (
          <div class="blob-foot">
            此浏览器为本工作区共占用约 {fmtBytes(usage)}（含本地数据库与缓存）。缓存超过 {fmtBytes(BLOB_QUOTA_BYTES)} 时自动清理最久没用、已在云桶的，你固定的不动。
          </div>
        )}
      </div>
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
  lastAttemptAt: number | null;
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

  // Resolve a bucket's full config (incl. the secret needed to mint an enroll
  // token). The server (origin/desktop sidecar) holds the secret on its
  // master-token-gated /api surface; in no-origin the replica IS the home.
  const getConfig = (peerUrl: string): Promise<S3Config | null> =>
    noOrigin
      ? replicaCall<S3Config | null>("storagePeerConfig", peerUrl)
      : api.serverS3Config(peerUrl);

  // Buckets this device can enroll another device onto.
  const bucketList = ((noOrigin ? localPeers : serverPeers) ?? []).map((pr) => ({
    url: pr.url,
    name: pr.label || pr.bucket || pr.url,
  }));

  // Unified "添加设备": phone (scan/link), computer/CLI (command/code), or — with
  // a server — live HTTP pairing. Carries the bucket's enroll token, never the
  // passphrase. Single entry point; the per-row "open on phone" button is gone.
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
              <Icon name="cube" cls="ico sm" /> 连接存储桶
            </button>
            {(!noOrigin || bucketList.length > 0) && (
              <button class="btn btn-secondary" onClick={addDevice}>
                <Icon name="monitor" cls="ico sm" /> 添加设备
              </button>
            )}
            {hasRows && (
              <button class="btn btn-secondary" onClick={syncNow}>
                <Icon name="cloudUp" cls="ico sm" /> 立即同步
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
  const base = (shellBase || location.origin).replace(/\/+$/, "");
  return `${base}/#enroll=${encodeEnroll(c)}`;
}

type AddTab = "phone" | "cli" | "server";

/** Render `data` as a polished inline QR: rounded-dot data modules, rounded
 *  finder eyes, and a centre cube badge. Foreground/background come from CSS
 *  vars (--qr-fg / --qr-bg on .qr-box) so it adapts to light/dark with zero JS.
 *  ECC "H" (30% recovery) keeps it scannable despite the centre logo cut-out. */
function QrSvg({ data }: { data: string }) {
  const qr = qrcode(0, "H");
  qr.addData(data);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 2; // quiet zone (modules) — .qr-box padding adds the rest
  const mid = n / 2;
  const logo = Math.max(5, Math.floor(n * 0.22)); // centre clear-zone (modules)
  const half = logo / 2;

  // The three 7×7 finder patterns (corners) get drawn as eyes, not dots.
  const inFinder = (r: number, c: number) =>
    (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  // Cleared square behind the centre badge.
  const inLogo = (r: number, c: number) =>
    Math.abs(r + 0.5 - mid) < half && Math.abs(c + 0.5 - mid) < half;

  const dots: ComponentChild[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c) || inFinder(r, c) || inLogo(r, c)) continue;
      dots.push(<circle key={r * n + c} cx={c + 0.5} cy={r + 0.5} r={0.45} fill="var(--qr-fg)" />);
    }
  }

  // A finder eye: rounded outer ring (1-module stroke) + rounded inner square.
  const eye = (fr: number, fc: number) => (
    <>
      <rect x={fc + 0.5} y={fr + 0.5} width={6} height={6} rx={2} ry={2} fill="none" stroke="var(--qr-fg)" stroke-width={1} />
      <rect x={fc + 2} y={fr + 2} width={3} height={3} rx={1} fill="var(--qr-fg)" />
    </>
  );

  const badge = logo + 0.6; // bg rect rounds the square hole + covers its edges
  const s = (logo * 0.62) / 24; // scale the 24-unit cube path to ~62% of clear-zone

  return (
    <div class="qr-box">
      <svg viewBox={`${-margin} ${-margin} ${n + margin * 2} ${n + margin * 2}`} shape-rendering="geometricPrecision">
        {dots}
        {eye(0, 0)}
        {eye(0, n - 7)}
        {eye(n - 7, 0)}
        <rect x={mid - badge / 2} y={mid - badge / 2} width={badge} height={badge} rx={badge * 0.26} ry={badge * 0.26} fill="var(--qr-bg)" />
        <g
          class="qr-cube"
          transform={`translate(${mid} ${mid}) scale(${s}) translate(-12 -12)`}
          fill="none"
          stroke="var(--qr-fg)"
          stroke-width={1.6}
          stroke-linejoin="round"
          stroke-linecap="round"
        >
          <path class="qr-cube-edge qr-cube-outer" pathLength={1} d={CUBE_OUTER} />
          <path class="qr-cube-edge qr-cube-inner" pathLength={1} d={CUBE_INNER} />
          <path class="qr-cube-glint" pathLength={1} d={CUBE_OUTER} />
          <path class="qr-cube-glint" pathLength={1} d={CUBE_INNER} />
        </g>
      </svg>
    </div>
  );
}

/** Full-width copy-to-clipboard button with a toast confirmation. */
function CopyRow({ text, label, done, primary }: { text: string; label: string; done: string; primary?: boolean }) {
  return (
    <button
      class={"btn " + (primary ? "btn-primary" : "btn-secondary")}
      style={{ width: "100%", marginTop: 10 }}
      onClick={() => {
        navigator.clipboard?.writeText(text);
        toast(done);
      }}
    >
      <Icon name="copy" cls="ico sm" /> {label}
    </button>
  );
}

/** Phone tab: a QR (and copyable link) a phone scans to join the bucket. */
function PhoneEnroll({ config }: { config: S3Config }) {
  const [shellBase, setShellBase] = useState(() => {
    try {
      return localStorage.getItem(SHELL_BASE_KEY) || location.origin;
    } catch {
      return location.origin;
    }
  });
  const url = enrollUrl(shellBase, config);
  const onBase = (v: string) => {
    setShellBase(v);
    try {
      v ? localStorage.setItem(SHELL_BASE_KEY, v) : localStorage.removeItem(SHELL_BASE_KEY);
    } catch {
      /* private mode */
    }
  };
  return (
    <>
      <QrSvg data={url} />
      <div class="field-label">壳地址（手机访问的静态站点域名；留空用当前地址）</div>
      <input
        class="text-input"
        placeholder={location.origin}
        value={shellBase}
        onInput={(e) => onBase((e.target as HTMLInputElement).value)}
      />
      <CopyRow text={url} label="复制链接" done="已复制链接" />
      <div class="peer-sub" style="margin-top:8px">手机相机扫码打开,输入加密口令即可同步。</div>
    </>
  );
}

/** Computer/CLI tab: a one-line `mh` command (and the raw code) to join the bucket. */
function CliEnroll({ config }: { config: S3Config }) {
  const token = encodeEnroll(config);
  const cmd = `mh config peer add --s3 --enroll ${token}`;
  return (
    <>
      <div class="field-label">在另一台电脑的终端运行</div>
      <div class="enroll-cmd">{cmd}</div>
      <CopyRow text={cmd} label="复制命令" done="已复制命令" primary />
      <CopyRow text={token} label="复制接入码" done="已复制接入码" />
      <div class="peer-sub" style="margin-top:8px">
        对方运行后会提示输入加密口令。也可在 <code>mh config</code> 向导选「粘贴接入码加入存储」。
      </div>
    </>
  );
}

/** A generated pairing code with a live countdown to expiry. */
function PairCodeView({ code, exp }: { code: string; exp: number }) {
  const [left, setLeft] = useState(Math.max(0, Math.round((exp - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.round((exp - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [exp]);
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  return (
    <>
      <div class="pair-code">{code}</div>
      <div class="muted" style={{ textAlign: "center", marginTop: 8 }}>
        {left > 0 ? `${mm}:${ss} 后过期` : "已过期,请重新生成"}
      </div>
      <CopyRow text={code} label="复制配对码" done="已复制配对码" />
    </>
  );
}

/** Advanced tab: live HTTP pairing against a server (generate / redeem a one-time
 *  code), plus the server-login QR a phone scans to open this server. */
function ServerPairing({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState<{ code: string; exp: number } | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const gen = async () => {
    setGenBusy(true);
    try {
      setCode(await api.newPairingCode());
    } catch (e) {
      toast(`生成失败：${(e as Error).message}`);
    } finally {
      setGenBusy(false);
    }
  };

  const [url, setUrl] = useState("");
  const [rcode, setRcode] = useState("");
  const [selfUrl, setSelfUrl] = useState(location.origin);
  const [busy, setBusy] = useState(false);
  const redeem = async () => {
    if (!url.trim() || !rcode.trim()) return toast("地址和配对码必填");
    setBusy(true);
    try {
      const r = await api.addPeerByPairing({ url: url.trim(), code: rcode.trim(), self_url: selfUrl.trim() || undefined });
      await api.syncPeer(r.url).catch(() => {});
      toast(`已配对 ${r.url}`);
      onPaired();
    } catch (e) {
      toast(`配对失败：${(e as Error).message}`);
      setBusy(false);
    }
  };

  const [base, setBase] = useState(() => {
    try {
      return localStorage.getItem(SERVER_BASE_KEY) || location.origin;
    } catch {
      return location.origin;
    }
  });
  const onBase = (v: string) => {
    setBase(v);
    try {
      v ? localStorage.setItem(SERVER_BASE_KEY, v) : localStorage.removeItem(SERVER_BASE_KEY);
    } catch {
      /* private mode */
    }
  };
  const loginUrl = originEnrollUrl(base, currentToken());

  return (
    <>
      <div class="enroll-section">邀请另一台服务器配对</div>
      {code ? (
        <PairCodeView code={code.code} exp={code.exp} />
      ) : (
        <button class="btn btn-secondary" style={{ width: "100%" }} disabled={genBusy} onClick={gen}>
          <Icon name="link" cls="ico sm" /> {genBusy ? "生成中…" : "生成本机配对码"}
        </button>
      )}

      <div class="enroll-sep" />
      <div class="enroll-section">已有对方的配对码?</div>
      <div class="field-label">对方服务器地址</div>
      <input class="text-input" placeholder="http://192.168.1.10:7777" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
      <div class="field-label">配对码</div>
      <input
        class="text-input"
        placeholder="对方「生成本机配对码」得到的码"
        value={rcode}
        onInput={(e) => setRcode((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === "Enter" && redeem()}
      />
      <div class="field-label">本机可达地址（可选）</div>
      <input class="text-input" placeholder="留空则仅本机主动同步" value={selfUrl} onInput={(e) => setSelfUrl((e.target as HTMLInputElement).value)} />
      <button class="btn btn-primary" style={{ width: "100%", marginTop: 10 }} disabled={busy} onClick={redeem}>
        {busy ? "配对中…" : "配对"}
      </button>

      <div class="enroll-sep" />
      <div class="enroll-section">在手机上打开本服务器</div>
      <QrSvg data={loginUrl} />
      <div class="field-label">服务器地址（手机访问的域名；留空用当前地址）</div>
      <input class="text-input" placeholder={location.origin} value={base} onInput={(e) => onBase((e.target as HTMLInputElement).value)} />
      <CopyRow text={loginUrl} label="复制链接" done="已复制链接" />
      <div class="peer-sub" style="margin-top:8px">⚠ 含访问令牌,请勿公开分享。</div>
    </>
  );
}

/** Unified "添加设备" surface: one modal that brings another device onto the
 *  workspace — a phone (scan/link), a computer/CLI (command/code), or, against a
 *  server, live HTTP pairing. The enroll token carries bucket access only (never
 *  the passphrase); the joining device types that. Replaces the old per-bucket
 *  QrModal, the server-login OriginQrModal, and the pairing add/code modals. */
function AddDeviceModal({
  buckets,
  getConfig,
  server,
  onPaired,
}: {
  buckets: { url: string; name: string }[];
  getConfig: (url: string) => Promise<S3Config | null>;
  server: boolean;
  onPaired: () => void;
}) {
  const hasBuckets = buckets.length > 0;
  const tabs: { id: AddTab; label: string }[] = [
    ...(hasBuckets
      ? ([
          { id: "phone", label: "手机扫码" },
          { id: "cli", label: "电脑 / 命令行" },
        ] as { id: AddTab; label: string }[])
      : []),
    ...(server ? ([{ id: "server", label: "高级:服务器配对" }] as { id: AddTab; label: string }[]) : []),
  ];
  const [tab, setTab] = useState<AddTab>(tabs[0]?.id ?? "server");
  const [bucketUrl, setBucketUrl] = useState(buckets[0]?.url ?? "");
  const [config, setConfig] = useState<S3Config | null>(null);
  const [loadErr, setLoadErr] = useState("");

  useEffect(() => {
    if (!hasBuckets || !bucketUrl) return;
    let live = true;
    setConfig(null);
    setLoadErr("");
    getConfig(bucketUrl)
      .then((c) => {
        if (!live) return;
        c ? setConfig(c) : setLoadErr("找不到该存储的配置");
      })
      .catch((e) => live && setLoadErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [bucketUrl]);

  return (
    <Modal
      title="添加设备"
      sub="让另一台设备加入同一个工作区——手机扫码,或在电脑上粘贴接入码。"
      footer={<button class="btn btn-primary" onClick={closeModal}>完成</button>}
      width={420}
    >
      {tabs.length > 1 && (
        <div class="add-tabs">
          {tabs.map((t) => (
            <button key={t.id} class={"add-tab" + (tab === t.id ? " on" : "")} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {(tab === "phone" || tab === "cli") && (
        <>
          {buckets.length > 1 && (
            <>
              <div class="field-label">存储桶</div>
              <select
                class="text-input"
                value={bucketUrl}
                onChange={(e) => setBucketUrl((e.target as HTMLSelectElement).value)}
              >
                {buckets.map((b) => (
                  <option key={b.url} value={b.url}>{b.name}</option>
                ))}
              </select>
            </>
          )}
          {loadErr ? (
            <div class="enroll-err">{loadErr}</div>
          ) : !config ? (
            <div class="muted">加载中…</div>
          ) : tab === "phone" ? (
            <PhoneEnroll config={config} />
          ) : (
            <CliEnroll config={config} />
          )}
          {config && (
            <div class="peer-sub" style="margin-top:8px">
              ⚠ 接入码含桶访问密钥,请勿公开分享;不含加密口令——新设备需另输口令。
            </div>
          )}
        </>
      )}

      {tab === "server" && <ServerPairing onPaired={onPaired} />}
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

// The server-login QR ("在手机上打开本服务器") now lives in AddDeviceModal's
// 「高级:服务器配对」 tab (ServerPairing); originEnrollUrl + SERVER_BASE_KEY above
// are shared with it.

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
  { id: "custom", name: "自定义", region: "auto", ph: "https://s3.example.com", hint: "任何 S3 兼容存储桶。" },
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
      <div class="set-hint" style={{ marginTop: 0, marginBottom: 12 }}>
        {toServer
          ? "连接后,云端工作区负责把整库同步到这个桶;这台设备和其他设备都从它同步。"
          : "连接后,这台设备(本机)把整库同步到这个桶;新设备扫码加入即可一起用。"}
      </div>
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
          {capturing ? "按下组合键…" : (
            <span class="qn-keys">
              {shortcutTokens(shortcut).map((k) => (
                <span class={"qn-key" + (MOD_GLYPHS.has(k) ? " sym" : "")}>{k}</span>
              ))}
            </span>
          )}
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
        已直接配对的设备(服务器 HTTP 双向同步)。新增请用上方「同步 → 添加设备 → 高级:服务器配对」。
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
                  {p.enabled ? "已启用" : "已禁用"} · 最近同步 {fmtTime(p.last_success_at)}
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

// PairingCodeModal + AddPeerModal folded into AddDeviceModal's 「高级:服务器配对」
// tab (PairCodeView + ServerPairing).
