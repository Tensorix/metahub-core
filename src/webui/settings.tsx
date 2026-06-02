/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import { Icon } from "./icons.tsx";
import { getTheme, setTheme, type ThemeChoice } from "./theme.ts";
import { api, type Peer } from "./api.ts";
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

export function SettingsView() {
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

      <SyncDevices />
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
