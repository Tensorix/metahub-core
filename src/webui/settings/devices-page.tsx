/** @jsxImportSource preact */
// 设备 — the unified device roster (core sync/devices.ts) as a product page:
// a device is a NAME with a form-factor glyph (synced roster, node.ts), one
// plain sentence of status, and — expanded — a key/value table, one action
// row and at most one sentence of consequence. Channel kinds never reach the
// user as vocabulary; they are translated into "how it connects". Devices
// quiet for 30+ days fold into their own group so the real job (kick out the
// ones you no longer use) reads at a glance.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, type DeviceView, type Peer, type S3Peer } from "../api.ts";
import { Icon } from "../icons.tsx";
import { timeAgo } from "../date.ts";
import { toast, confirmDialog, promptDialog, openModal, closeModal } from "../ui.tsx";
import { clientMode } from "../data/replica.ts";
import { scopesFor } from "../data/scopes.ts";
import { SetRow, SetSection, PageHeader, SetRowSkeleton } from "./primitives.tsx";
import { useSkeletonRows, SkelText } from "../skeleton.tsx";
import { pageLabel } from "./nav.ts";
import { AddDeviceModal, RotateModal } from "./modals.tsx";
import { fmtTime, isDesktop } from "./shared.ts";

const STALE_MS = 30 * 24 * 3600e3;

/** Glyph per form factor (synced roster); unknown → a generic screen. */
export function deviceIcon(form: DeviceView["form"] | null | undefined): string {
  switch (form) {
    case "laptop":
      return "laptop";
    case "phone":
      return "phone";
    case "server":
      return "server";
    case "browser":
      return "globe";
    default:
      return "monitor";
  }
}

const APP_WORD: Record<string, string> = { cli: "命令行", server: "服务器", desktop: "桌面应用", web: "浏览器" };
const PLATFORM_WORD: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
  web: "网页",
};

/** "3 天前活跃" while recent; a date once it has gone quiet — never the
 *  half-relative "最近活动 2026/7/23". */
function activeCopy(t: number | null): string {
  if (t == null) return "还没有活动";
  return Date.now() - t < STALE_MS ? `${timeAgo(t)}活跃` : `${fmtDay(t)}后无活动`;
}
const fmtDay = (t: number) => {
  const d = new Date(t);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

/** What the roster's `self` means on this surface: the desktop sidecar IS this
 *  machine; against a remote server it is the workspace primary. */
function selfTag(): string {
  if (isDesktop()) return "这台设备";
  return scopesFor(clientMode()).find((s) => s.kind === "server")?.label ?? "服务器";
}

export function DevicesPage() {
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [buckets, setBuckets] = useState<S3Peer[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [presenceRefreshing, setPresenceRefreshing] = useState(false);
  const [skelRows, rememberRows] = useSkeletonRows("devices");

  const reload = () => {
    api.listDevices().then(setDevices).catch((e) => toast(`加载失败：${e.message}`));
    api.listPeers().then(setPeers).catch(() => undefined);
    api.listServerS3Peers().then(setBuckets).catch(() => undefined);
  };
  useEffect(() => {
    let live = true;
    api.listPeers().then((rows) => live && setPeers(rows)).catch(() => undefined);
    api.listServerS3Peers().then((rows) => live && setBuckets(rows)).catch(() => undefined);
    api.listDevices()
      .then((rows) => {
        if (!live) return;
        setDevices(rows);
        rememberRows(rows.length);
        setPresenceRefreshing(true);
        return api.refreshDevicePresence();
      })
      .then((resolved) => {
        if (live && resolved) setDevices(resolved.devices);
      })
      .catch((e) => live && toast(`设备来源刷新失败：${e.message}`))
      .finally(() => live && setPresenceRefreshing(false));
    return () => {
      live = false;
    };
  }, []);

  const bucketName = (url: string) => {
    const b = buckets.find((x) => x.url === url);
    return b?.label || b?.bucket || url;
  };
  const deviceName = (d: DeviceView) => d.label ?? "未命名设备";
  const key = (d: DeviceView) => d.nodeId ?? `grant:${d.channels[0]?.ref ?? ""}`;

  // ---- actions ------------------------------------------------------------
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
  const removePeerRow = async (d: DeviceView, url: string) => {
    const ok = await confirmDialog({
      title: `移除 ${deviceName(d)}`,
      message: "将停止与它的直连同步。它上面已同步的数据仍在，无法远程删除。",
      confirmLabel: "移除",
      danger: true,
    });
    if (!ok) return;
    await api.removePeer(url).catch((e) => toast(e.message));
    reload();
  };
  const revokeGrantRef = async (d: DeviceView, prefix: string) => {
    const ok = await confirmDialog({
      title: `撤销 ${deviceName(d)} 的接入`,
      message: "它将无法再同步进这个工作区。已同步到它上面的数据仍在，无法远程删除。",
      confirmLabel: "撤销接入",
      danger: true,
    });
    if (!ok) return;
    await api.revokeGrant(prefix).catch((e) => toast(e.message));
    reload();
  };
  const rename = async (d: DeviceView) => {
    if (!d.nodeId) return;
    const v = await promptDialog({
      title: d.self ? "重命名这台设备" : `给 ${deviceName(d)} 起个名字`,
      label: "所有设备都会看到这个名字",
      value: d.label ?? "",
      placeholder: "例如：工作室 iMac",
    });
    if (v == null || v === (d.label ?? "")) return;
    try {
      await api.setNodeLabel(v, d.nodeId);
    } catch (e) {
      toast(`重命名失败：${(e as Error).message}`);
    }
    reload();
  };
  const rotate = (d: DeviceView) => {
    const targets = buckets.filter((b) => d.revocationSources.includes(b.url));
    openModal(
      <RotateModal
        buckets={targets.length ? targets : buckets}
        onDone={() => {
          closeModal();
          reload();
        }}
      />,
    );
  };
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

  // ---- copy ---------------------------------------------------------------
  /** One sentence: how it connects · when it was last active. */
  const caption = (d: DeviceView) => {
    if (d.self)
      return (
        <>
          <span class="cap-dot ok" />
          {isDesktop() ? "这台设备" : "工作区所在的服务器"} · {activeCopy(d.lastActivityAt)}
        </>
      );
    const bucket = d.channels.find((c) => c.kind === "bucket_presence");
    const paired = d.channels.find((c) => c.kind === "paired_out");
    const grant = d.channels.find((c) => c.kind === "grant_in");
    const how = bucket
      ? `经存储桶 ${bucketName(bucket.ref)} 同步`
      : paired
        ? peers.find((p) => p.url === paired.ref)?.enabled
          ? "直连同步"
          : "直连已暂停"
        : grant
          ? "通过授权码接入"
          : "曾同步过";
    return `${how} · ${activeCopy(d.lastActivityAt)}`;
  };

  const detail = (d: DeviceView) => {
    const paired = d.channels.filter((c) => c.kind === "paired_out");
    const grants = d.channels.filter((c) => c.kind === "grant_in");
    const bucketsIn = d.channels.filter((c) => c.kind === "bucket_presence");
    const ways: ComponentChildren[] = [];
    if (d.self) ways.push(isDesktop() ? "工作区所在的这台设备" : "工作区所在的服务器");
    for (const c of bucketsIn)
      ways.push(
        <>
          经存储桶 {bucketName(c.ref)}
          {c.leaseLiveUntil ? <span class="muted">（在线，租约至 {fmtTime(c.leaseLiveUntil)}）</span> : null}
        </>,
      );
    for (const c of paired)
      ways.push(
        <>
          直连 <span class="mono">{c.ref}</span>
        </>,
      );
    for (const c of grants)
      ways.push(
        <>
          授权码 <span class="mono">{c.ref.slice(0, 8)}…</span>
        </>,
      );
    if (ways.length === 0) ways.push("曾写入过工作区，来源未确认");
    const appLine = [d.app && APP_WORD[d.app], d.platform && PLATFORM_WORD[d.platform]].filter(Boolean).join(" · ");
    return (
      <>
        <dl class="device-kv">
          <dt>接入方式</dt>
          <dd>
            {ways.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </dd>
          {appLine && (
            <>
              <dt>应用</dt>
              <dd>{appLine}</dd>
            </>
          )}
          {d.nodeId && (
            <>
              <dt>节点 ID</dt>
              <dd class="mono">{d.nodeId}</dd>
            </>
          )}
          <dt>最近活动</dt>
          <dd>{d.lastActivityAt ? fmtTime(d.lastActivityAt) : "—"}</dd>
        </dl>
        <div class="device-actions">
          {d.nodeId && (
            <button class="btn btn-ghost" onClick={() => rename(d)}>
              <Icon name="pencil" cls="ico sm" />
              重命名
            </button>
          )}
          {paired.map((c) => {
            const on = !!peers.find((x) => x.url === c.ref)?.enabled;
            return (
              <>
                <button class="btn btn-ghost" onClick={() => syncNow(c.ref)}>
                  <Icon name="refresh" cls="ico sm" />
                  立即同步
                </button>
                <button class="btn btn-ghost" onClick={() => togglePeer(c.ref)}>
                  <Icon name={on ? "pause" : "play"} cls="ico sm" />
                  {on ? "暂停同步" : "恢复同步"}
                </button>
                <button class="btn btn-ghost danger" onClick={() => removePeerRow(d, c.ref)}>
                  <Icon name="trash" cls="ico sm" />
                  移除
                </button>
              </>
            );
          })}
          {!d.self &&
            grants.map((c) => (
              <button class="btn btn-ghost danger" onClick={() => revokeGrantRef(d, c.ref)}>
                <Icon name="lock" cls="ico sm" />
                撤销接入
              </button>
            ))}
          {!d.self && d.revocable === "bucket_rotate" && (
            <button class="btn btn-ghost" onClick={() => rotate(d)}>
              <Icon name="key" cls="ico sm" />
              更换存储密钥…
            </button>
          )}
        </div>
        {!d.self && grants.length > 0 && paired.length === 0 && (
          <div class="device-note">撤销后它不能再同步进来；此前已同步到它上面的数据无法远程删除。</div>
        )}
        {!d.self && d.revocable === "bucket_rotate" && (
          <div class="device-note">
            这台设备和其他设备共用同一把存储密钥，无法单独移除。<b>更换密钥</b>后它将不能再同步；已下载到它上面的数据无法追回。
          </div>
        )}
        {!d.self && d.revocable === "unknown" && (
          <div class="device-note">
            {presenceRefreshing
              ? "正在核对已连接的存储桶…"
              : "只能确认它曾写入过工作区，无法确认它现在经哪条渠道接入，所以这里不提供断开操作。"}
          </div>
        )}
      </>
    );
  };

  const row = (d: DeviceView) => {
    const k = key(d);
    const expanded = open === k;
    const stale = !d.self && (d.lastActivityAt == null || Date.now() - d.lastActivityAt > STALE_MS);
    return (
      <SetRow
        key={k}
        lead={<Icon name={deviceIcon(d.form)} />}
        dim={stale && !expanded}
        title={
          <>
            <span class="set-row-name">{deviceName(d)}</span>
            {d.self && <span class="set-row-tag self">{selfTag()}</span>}
            {!d.label && d.nodeId && <span class="set-row-tag mono">{d.nodeId}</span>}
          </>
        }
        caption={caption(d)}
        onClick={() => setOpen(expanded ? null : k)}
        control={
          <span class={`row-chev${expanded ? " open" : ""}`}>
            <Icon name="chevronDown" />
          </span>
        }
      >
        {expanded && detail(d)}
      </SetRow>
    );
  };

  const list = devices ?? [];
  const recent = list.filter((d) => d.self || (d.lastActivityAt != null && Date.now() - d.lastActivityAt <= STALE_MS));
  const stale = list.filter((d) => !recent.includes(d));

  return (
    <>
      <PageHeader
        title={pageLabel("devices")}
        sub={devices == null ? <SkelText /> : `${devices.length} 台设备同步过这个工作区。`}
        action={
          <button class="btn btn-primary" onClick={addDevice}>
            <Icon name="plus" cls="ico sm" />
            添加设备
          </button>
        }
      />
      {devices == null ? (
        <SetSection label="最近 30 天">
          <SetRowSkeleton rows={skelRows} lead control="chevron" />
        </SetSection>
      ) : (
        <SetSection label="最近 30 天" count={recent.length}>
          {recent.length === 0 ? <div class="muted">还没有其他设备。</div> : recent.map(row)}
        </SetSection>
      )}
      {stale.length > 0 && (
        <SetSection
          label="很久没活动"
          count={stale.length}
          caption="超过 30 天没有同步的设备。如果已经不再使用，可以在这里撤销它们的接入。"
        >
          {stale.map(row)}
        </SetSection>
      )}
    </>
  );
}
