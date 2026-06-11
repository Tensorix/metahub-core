/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Icon } from "./icons.tsx";
import { getTheme, setTheme, type ThemeChoice } from "./theme.ts";
import { api, type Peer, type Grant } from "./api.ts";
import {
  replicaEnabled,
  replicaStatus,
  onReplicaStatus,
  enableReplica,
  disableReplica,
  requestSync,
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

      <div class="set-section">
        <div class="set-section-head">外观</div>
        <div class="set-section-desc">选择界面的颜色主题。</div>
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

      {typeof window !== "undefined" && window.metahubDesktop?.quicknote && <QuickNotesSettings />}
      {replicaSupported() && <OfflineReplica />}
      <SyncDevices />
      <IssuedGrants />
      <VersionFooter onUpdatePending={onUpdatePending} />
    </div>
  );
}

// ---- offline replica (browser as a sync node) ------------------------------

function replicaSupported(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.storage?.getDirectory
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
  const [enabled, setEnabled] = useState(replicaEnabled());
  const [st, setSt] = useState<ReplicaStatus>(replicaStatus());
  const [busy, setBusy] = useState(false);

  useEffect(() => onReplicaStatus((s) => setSt({ ...s })), []);

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

  return (
    <div class="set-section">
      <div class="set-section-head">离线副本</div>
      <div class="set-section-desc">
        让此浏览器持有完整的本地数据副本：弱网/离线也能查看和编辑全部内容，恢复连接后自动同步。
        启用即与服务器配对，凭据可在「已授权设备」中单独吊销。
      </div>
      <div class="peer-actions">
        {enabled ? (
          <>
            <button class="btn btn-secondary" disabled={busy} onClick={() => requestSync()}>
              <Icon name="share" cls="ico sm" /> 立即同步
            </button>
            <button class="btn btn-ghost" disabled={busy} onClick={disable}>
              停用
            </button>
          </>
        ) : (
          <button class="btn btn-primary" disabled={busy} onClick={enable}>
            <Icon name="check" cls="ico sm" /> {busy ? "启用中…" : "启用离线副本"}
          </button>
        )}
      </div>
      <div class="peer-sub" style="margin-top:8px">
        {statusLine()}
        {enabled && st.node ? ` · 节点 ${st.node}` : ""}
      </div>
    </div>
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
      const f = floor();
      if (l && (!f || cmpVer(l, f) > 0)) {
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
    <div class="set-section">
      <div class="set-section-head">快速笔记</div>
      <div class="set-section-desc">
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
    <div class="set-section">
      <div class="set-section-head">同步设备</div>
      <div class="set-section-desc">
        与其他设备配对，自动双向同步数据。在对方设备生成配对码，然后在此添加。
      </div>

      <div class="peer-actions">
        <button class="btn btn-primary" onClick={addPeer}>
          <Icon name="plus" cls="ico sm" /> 添加设备
        </button>
        <button class="btn btn-secondary" onClick={showCode}>
          <Icon name="link" cls="ico sm" /> 生成本机配对码
        </button>
      </div>

      <div class="peer-list">
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
    <div class="set-section">
      <div class="set-section-head">已授权设备</div>
      <div class="set-section-desc">
        本机签发、允许其他设备同步进来的凭据。吊销即断开对方的入站访问。
      </div>
      <div class="peer-list">
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
