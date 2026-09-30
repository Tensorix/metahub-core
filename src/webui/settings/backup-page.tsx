/** @jsxImportSource preact */
// 数据与备份 — the workspace page. One health sentence under the title (same
// derivation as `mh status`), then ONE row per place holding a copy of the
// workspace — the data map itself: this node, direct-sync devices (HTTP peers)
// and buckets. Click a row to expand its facts and its channel actions (sync
// now / pause / stop / rotate…), the same gesture as the 设备 page, which keeps
// only identity actions (rename / revoke / rotate). Below, the attachment
// store (bytes + one status sentence) and the long-term copy policy (which
// places keep every attachment). Data/ownership rules are unchanged from
// doc 19: origin buckets live on the server and are mirrored read-only here;
// a trusted replica may re-enter the secret to sync one directly; no-origin
// owns its own list.
import { useEffect, useState } from "preact/hooks";
import {
  api,
  type S3Peer,
  type Peer,
  type BlobCacheInfo,
  type EdgeStatus,
  type DataMap,
  type DataPlace,
  type NodeInfo,
} from "../api.ts";
import type { S3Config } from "../../core/sync/storage.ts";
import { Icon } from "../icons.tsx";
import { timeAgo } from "../date.ts";
import { t } from "../i18n/t.ts";
import {
  dataMapHeadline,
  dataMapIssueLines,
  dataMapTone,
  placeCaption,
  selfPlaceCopy,
  PLACE_ROLE_LABEL,
} from "../data-map-status.ts";
import { replicaEnabled, onReplicaStatus, isNoOrigin, clientMode, call as replicaCall } from "../data/replica.ts";
import { scopesFor, type Scope } from "../data/scopes.ts";
import { openBlobManager } from "../blob-manager.tsx";
import { openModal, closeModal, toast, confirmDialog, openMenu, MenuItem } from "../ui.tsx";
import {
  EdgeDeployModal,
  ActivateBucketOnDeviceModal,
  AddStorageModal,
  AddDeviceModal,
  AddDirectPeerModal,
  RotateModal,
  RecoveryCodeModal,
} from "./modals.tsx";
import { isDesktop, fmtBytes, fmtTime, providerName, regionName, type StoragePeerView } from "./shared.ts";
import { pageLabel } from "./nav.ts";
import { SetRow, Switch, SetSection, PageHeader, RowSelect, SetRowSkeleton } from "./primitives.tsx";
import { useSkeletonRows, SkelText } from "../skeleton.tsx";
import { CacheRingHero, type RingState } from "./cache-ring.tsx";
import { deviceIcon, APP_WORD, PLATFORM_WORD } from "./devices-page.tsx";

/** The workspace data map, refreshed every 30s and on demand. */
function useSyncHealth(): [DataMap | null, () => void] {
  const [map, setMap] = useState<DataMap | null>(null);
  const tick = () => api.syncHealth().then(setMap).catch(() => undefined);
  useEffect(() => {
    let live = true;
    const t0 = () => api.syncHealth().then((m) => live && setMap(m)).catch(() => undefined);
    t0();
    const timer = setInterval(t0, 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return [map, tick];
}

/** One sentence under the title: how many places hold the data and the one
 *  thing (if any) needing attention. The dot alone carries tone. */
function HealthSub({ map }: { map: DataMap | null }) {
  if (!map) return <SkelText />;
  return (
    <span class="sync-health-sub">
      <span class={`sync-health-dot dot-${dataMapTone(map)}`} />
      {dataMapHeadline(map)}
    </span>
  );
}

/** Concurrent problems, listed only when there is more than one — a single
 *  problem is already carried by its own row's caption and inline retry. */
function HealthIssues({ map }: { map: DataMap | null }) {
  const lines = map ? dataMapIssueLines(map) : [];
  if (lines.length < 2) return null;
  return (
    <div class="set-callout warn">
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}

type BucketRow = S3Peer | StoragePeerView;
const KIND_ORDER: Record<DataPlace["kind"], number> = { self: 0, device: 1, bucket: 2 };

/** Role tags next to a place name: the neutral outline tag, never accent.
 *  `backend` (every bucket) and `replica` (every device) say nothing — skip. */
const roleTags = (p: DataPlace) =>
  p.roles
    .filter((r) => r !== "backend" && r !== "replica")
    .map((r) => (
      <span class="set-row-tag" key={r}>
        {PLACE_ROLE_LABEL[r]}
      </span>
    ));

export function BackupPage() {
  const noOrigin = isNoOrigin();
  const desktop = isDesktop();
  const mode = clientMode();
  // The workspace's blob store scope (云端工作区 / desktop 本机工作区). Absent
  // exactly in no-origin cells — those keep bytes only in the browser replica.
  const serverScope = scopesFor(mode).find((s) => s.kind === "server");
  const [enabled, setEnabled] = useState(replicaEnabled());
  const [serverPeers, setServerPeers] = useState<S3Peer[] | null>(null);
  const [localPeers, setLocalPeers] = useState<StoragePeerView[] | null>(null);
  const [httpPeers, setHttpPeers] = useState<Peer[]>([]);
  const [roster, setRoster] = useState<NodeInfo[]>([]);
  const [edge, setEdge] = useState<EdgeStatus | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busyUrl, setBusyUrl] = useState<string | null>(null);
  const [map, refreshHealth] = useSyncHealth();
  const [skelRows, rememberRows] = useSkeletonRows("places", 2);

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
      api.listServerS3Peers().then(setServerPeers).catch((e) => toast(t("加载失败：{msg}", { msg: (e as Error).message })));
      api.listPeers().then((rows) => setHttpPeers(rows.filter((p) => !p.url.startsWith("s3://")))).catch(() => undefined);
      api.nodes().then(setRoster).catch(() => undefined);
      api.getEdgeStatus().then(setEdge).catch(() => setEdge(null));
    }
    refreshHealth();
  };
  useEffect(() => {
    reload();
    return onReplicaStatus(() => {
      setEnabled(replicaEnabled());
      reloadLocal();
    });
  }, []);
  useEffect(() => {
    if (map) rememberRows(map.places.length);
  }, [map?.places.length]);

  const localUrls = new Set((localPeers ?? []).map((p) => p.url));
  const replicaOn = !desktop && enabled;
  const bucketRows: BucketRow[] = (noOrigin ? localPeers : serverPeers) ?? [];
  const bucketByUrl = new Map(bucketRows.map((b) => [b.url, b]));
  const peerByUrl = new Map(httpPeers.map((p) => [p.url, p]));

  const addBucket = () =>
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
  const addDirectPeer = () =>
    openModal(
      <AddDirectPeerModal
        onDone={() => {
          closeModal();
          reload();
        }}
      />,
    );
  const addTarget = (e: MouseEvent) =>
    openMenu(e, (close) => (
      <>
        <MenuItem
          icon="bucket"
          label={t("连接存储桶")}
          sublabel={t("所有设备通过它同步")}
          onClick={() => {
            close();
            addBucket();
          }}
        />
        <MenuItem
          icon="server"
          label={t("直连另一台服务器")}
          sublabel={t("两台服务器互相实时同步")}
          onClick={() => {
            close();
            addDirectPeer();
          }}
        />
      </>
    ));
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

  /** Sync one target now — bucket or direct peer; no-origin syncs everything. */
  const syncTarget = async (url: string) => {
    setBusyUrl(url);
    try {
      if (noOrigin) await replicaCall("sync");
      else {
        const r = await api.syncPeer(url);
        if (r.ok === false && r.error) throw new Error(r.error);
        if (replicaOn && localUrls.has(url)) await replicaCall("sync").catch(() => {});
      }
      toast(t("已触发同步"));
    } catch (e) {
      toast(t("同步失败：{msg}", { msg: (e as Error).message }));
    } finally {
      setBusyUrl(null);
      reload();
    }
  };

  const removeBucket = async (url: string, name: string) => {
    const ok = await confirmDialog({
      title: t("停止使用 {name}", { name }),
      message: t("将停止与它同步。桶内数据不受影响，可以随时重新连接。"),
      confirmLabel: t("停止使用"),
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
      title: t("停止此浏览器离线同步"),
      message: t("此浏览器将不再直连 {name}。存储桶仍在服务器上；此浏览器在线时照常经服务器同步。", { name }),
      confirmLabel: t("停止"),
      danger: true,
    });
    if (!ok) return;
    await replicaCall("removeStorageReplica", url).catch((e) => toast((e as Error).message));
    reload();
  };

  const togglePeer = async (url: string) => {
    const p = peerByUrl.get(url);
    await api.updatePeer(url, { enabled: !(p?.enabled ?? 0) }).catch((e) => toast((e as Error).message));
    reload();
  };
  const removeDirectPeer = async (url: string, name: string) => {
    const ok = await confirmDialog({
      title: t("停止直连 {name}", { name }),
      message: t("将停止与它的直连同步。它上面已同步的数据仍在，无法远程删除。"),
      confirmLabel: t("停止直连"),
      danger: true,
    });
    if (!ok) return;
    await api.removePeer(url).catch((e) => toast((e as Error).message));
    reload();
  };

  const getConfig = (peerUrl: string): Promise<S3Config | null> =>
    noOrigin
      ? replicaCall<S3Config | null>("storagePeerConfig", peerUrl)
      : api.serverS3Config(peerUrl);
  const bucketList = bucketRows.map((pr) => ({ url: pr.url, name: pr.label || pr.bucket || pr.url }));
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

  const nameOf = (p: BucketRow) => p.label || p.bucket || p.url;

  // ---- self ---------------------------------------------------------------
  const selfCopy = selfPlaceCopy(mode);
  const selfRow = (pl: DataPlace) => (
    <SetRow
      key="self"
      lead={<Icon name={desktop ? "laptop" : "server"} />}
      title={
        <>
          <span class="set-row-name">
            {pl.label === "本机" ? (selfCopy.labelOverride ?? pl.label) : pl.label}
          </span>
          {roleTags(pl)}
        </>
      }
      caption={
        <>
          <span class="cap-dot ok" />
          {t("实时 · 数据在这里产生")}
        </>
      }
    />
  );

  // ---- direct-sync device (HTTP peer) ------------------------------------
  const deviceRow = (pl: DataPlace) => {
    const url = pl.url!;
    const peer = peerByUrl.get(url);
    const paused = pl.freshness === "disabled";
    const failed = pl.freshness === "error";
    const expanded = open === url;
    const form = peer?.node_id ? roster.find((n) => n.node_id === peer.node_id)?.form : null;
    return (
      <SetRow
        key={url}
        lead={<Icon name={form ? deviceIcon(form) : "server"} />}
        dim={paused && !expanded}
        title={
          <>
            <span class="set-row-name">{pl.label}</span>
            <span class="set-row-tag">{t("直连")}</span>
            {roleTags(pl)}
          </>
        }
        caption={
          <>
            <span class={"cap-dot " + (failed ? "err" : paused ? "" : pl.freshness === "current" ? "ok" : "warn")} />
            <span class={failed ? "cap-err" : ""}>{paused ? t("已暂停") : placeCaption(pl)}</span>
          </>
        }
        onClick={() => setOpen(expanded ? null : url)}
        control={
          <>
            {failed && (
              <button
                class="btn btn-ghost sm"
                disabled={busyUrl === url}
                onClick={(e) => {
                  e.stopPropagation();
                  void syncTarget(url);
                }}
              >
                {busyUrl === url ? t("重试中…") : t("重试")}
              </button>
            )}
            <span class={`row-chev${expanded ? " open" : ""}`}>
              <Icon name="chevronDown" />
            </span>
          </>
        }
      >
        {expanded && (
          <>
            <dl class="device-kv">
              <dt>{t("地址")}</dt>
              <dd class="mono">{url}</dd>
              {peer?.node_id && (
                <>
                  <dt>{t("节点 ID")}</dt>
                  <dd class="mono">{peer.node_id}</dd>
                </>
              )}
              <dt>{t("上次成功同步")}</dt>
              <dd>{pl.syncedAt ? fmtTime(pl.syncedAt) : "—"}</dd>
              {pl.lag > 0 && (
                <>
                  <dt>{t("尚未确认")}</dt>
                  <dd>{t("{n} 条改动", { n: pl.lag })}</dd>
                </>
              )}
            </dl>
            <div class="device-actions">
              <button class="btn btn-ghost" disabled={busyUrl === url} onClick={() => void syncTarget(url)}>
                <Icon name="refresh" cls="ico sm" />
                {t("立即同步")}
              </button>
              <button class="btn btn-ghost" onClick={() => void togglePeer(url)}>
                <Icon name={paused ? "play" : "pause"} cls="ico sm" />
                {paused ? t("恢复同步") : t("暂停同步")}
              </button>
              <button class="btn btn-ghost danger" onClick={() => void removeDirectPeer(url, pl.label)}>
                <Icon name="trash" cls="ico sm" />
                {t("停止直连")}
              </button>
            </div>
            <div class="device-note">
              {t("这台设备的名字与接入权限在")} <a href="#/settings?sec=devices">{t("设备")}</a> {t("页管理。")}
            </div>
          </>
        )}
      </SetRow>
    );
  };

  // ---- bucket -------------------------------------------------------------
  /** vendor · region · last sync (· offline-capable) — or the failure, in red. */
  const bucketCaption = (p: BucketRow, direct: boolean) => {
    if (p.status === "error" && p.error)
      return (
        <>
          <span class="cap-dot err" />
          <span class="cap-err">{t("同步失败 · {error}", { error: p.error })}</span>
        </>
      );
    const parts = [
      providerName(p.provider, p.endpoint),
      regionName(p.region),
      p.lastSyncAt ? t("上次同步 {ago}", { ago: timeAgo(p.lastSyncAt) }) : t("还没同步过"),
      direct ? (noOrigin ? t("本机发布") : t("此浏览器可离线同步")) : null,
    ].filter(Boolean);
    return (
      <>
        <span class={"cap-dot " + (p.lastSyncAt ? "ok" : "")} />
        {parts.join(" · ")}
      </>
    );
  };

  /** Expanded facts + actions — the 设备 page's kv / actions / note trio. */
  const bucketDetail = (pl: DataPlace, p: BucketRow, onDevice: boolean) => {
    const sp = p as S3Peer;
    const name = nameOf(p);
    const prefix = "prefix" in p ? p.prefix : null;
    const encrypt = "encrypt" in p ? p.encrypt : null;
    const creds = noOrigin ? t("这台设备") : onDevice ? t("服务器，此浏览器也保存了一份") : t("服务器");
    return (
      <>
        <dl class="device-kv">
          <dt>{t("服务商")}</dt>
          <dd>{providerName(p.provider, p.endpoint)}{regionName(p.region) ? ` · ${regionName(p.region)}` : ""}</dd>
          {p.endpoint && (
            <>
              <dt>{t("地址")}</dt>
              <dd class="mono">{p.endpoint}</dd>
            </>
          )}
          {p.bucket && (
            <>
              <dt>{t("存储桶")}</dt>
              <dd class="mono">{p.bucket}{prefix ? ` / ${prefix}` : ""}</dd>
            </>
          )}
          {encrypt != null && (
            <>
              <dt>{t("加密")}</dt>
              <dd>{encrypt ? t("已加密，上传前在本地完成") : t("未加密")}</dd>
            </>
          )}
          <dt>{t("凭据保存在")}</dt>
          <dd>{creds}</dd>
          {pl.roles.length > 0 && (
            <>
              <dt>{t("用途")}</dt>
              <dd>{pl.roles.map((r) => PLACE_ROLE_LABEL[r]).join(" · ")}</dd>
            </>
          )}
          <dt>{t("上次同步")}</dt>
          <dd>{p.lastSyncAt ? fmtTime(p.lastSyncAt) : "—"}</dd>
        </dl>
        <div class="device-actions">
          <button class="btn btn-ghost" disabled={busyUrl === p.url} onClick={() => void syncTarget(p.url)}>
            <Icon name="refresh" cls="ico sm" />
            {t("立即同步")}
          </button>
          {!noOrigin && replicaOn && !onDevice && (
            <button class="btn btn-ghost" onClick={() => activateHere(sp)}>
              <Icon name="link" cls="ico sm" />
              {t("让此浏览器可离线同步")}
            </button>
          )}
          {onDevice && (
            <button class="btn btn-ghost" onClick={() => void detachHere(p.url, name)}>
              <Icon name="link" cls="ico sm" />
              {t("停止此浏览器离线同步")}
            </button>
          )}
          {!noOrigin && (
            <>
              <button class="btn btn-ghost" onClick={() => rotateBucket(sp)}>
                <Icon name="key" cls="ico sm" />
                {t("更换存储密钥…")}
              </button>
              <button class="btn btn-ghost" onClick={() => recoveryBucket(sp)}>
                <Icon name="copy" cls="ico sm" />
                {t("导出恢复码…")}
              </button>
            </>
          )}
          <button class="btn btn-ghost danger" onClick={() => void removeBucket(p.url, name)}>
            <Icon name="trash" cls="ico sm" />
            {t("停止使用")}
          </button>
        </div>
        {!noOrigin && replicaOn && !onDevice && (
          <div class="device-note">{t("让此浏览器可离线同步后，服务器连不上时它也能直接经存储桶同步。")}</div>
        )}
      </>
    );
  };

  const bucketRow = (pl: DataPlace) => {
    const url = pl.url!;
    const p = bucketByUrl.get(url);
    const name = p ? nameOf(p) : pl.label;
    const onDevice = !noOrigin && replicaOn && localUrls.has(url);
    const failed = pl.freshness === "error";
    const expanded = open === url;
    return (
      <SetRow
        key={url}
        lead={<Icon name="bucket" />}
        title={
          <>
            <span class="set-row-name">{name}</span>
            {roleTags(pl)}
          </>
        }
        caption={
          p ? (
            bucketCaption(p, noOrigin || onDevice)
          ) : (
            <>
              <span class={"cap-dot " + (failed ? "err" : "")} />
              <span class={failed ? "cap-err" : ""}>{placeCaption(pl)}</span>
            </>
          )
        }
        onClick={p ? () => setOpen(expanded ? null : url) : undefined}
        control={
          <>
            {failed && (
              <button
                class="btn btn-ghost sm"
                disabled={busyUrl === url}
                onClick={(e) => {
                  e.stopPropagation();
                  void syncTarget(url);
                }}
              >
                {busyUrl === url ? t("重试中…") : t("重试")}
              </button>
            )}
            {failed && !noOrigin && p && (
              <button
                class="btn btn-ghost sm"
                onClick={(e) => {
                  e.stopPropagation();
                  rotateBucket(p as S3Peer);
                }}
              >
                {t("更换密钥…")}
              </button>
            )}
            {p && (
              <span class={`row-chev${expanded ? " open" : ""}`}>
                <Icon name="chevronDown" />
              </span>
            )}
          </>
        }
      >
        {expanded && p && bucketDetail(pl, p, onDevice)}
      </SetRow>
    );
  };

  const placeRow = (pl: DataPlace) =>
    pl.kind === "self" ? selfRow(pl) : pl.kind === "device" ? deviceRow(pl) : bucketRow(pl);

  // no-origin without a replica: nothing can hold the bucket peer yet.
  if (noOrigin && !enabled) {
    return (
      <>
        <PageHeader title={pageLabel("backup")} sub={<HealthSub map={map} />} />
        <div class="set-callout warn" style={{ marginTop: 12 }}>
          {t("先在「离线与缓存」把这台设备设为在本机保存，再连接存储桶。")}{" "}
          <a href="#/settings?sec=offline">{t("前往设置")}</a>
        </div>
      </>
    );
  }

  const places = map ? [...map.places].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) : null;
  const hasBucket = !!places?.some((pl) => pl.kind === "bucket");
  const hasTargets = !!places?.some((pl) => pl.kind !== "self");

  return (
    <>
      <PageHeader
        title={pageLabel("backup")}
        sub={<HealthSub map={map} />}
        banner={<HealthIssues map={map} />}
        action={
          <>
            {noOrigin && bucketList.length > 0 && (
              <button class="btn btn-ghost" onClick={addDevice}>
                {t("添加设备")}
              </button>
            )}
            {noOrigin ? (
              <button class="btn btn-primary" onClick={addBucket}>
                <Icon name="plus" cls="ico sm" />
                {t("连接存储桶")}
              </button>
            ) : (
              <button class="btn btn-primary" onClick={(e) => addTarget(e as unknown as MouseEvent)}>
                <Icon name="plus" cls="ico sm" />
                {t("添加同步目标")}
                <Icon name="chevronDown" cls="ico sm" />
              </button>
            )}
          </>
        }
      />

      <SetSection
        label={t("同步目标")}
        caption={
          noOrigin
            ? t("这台设备的云端后端，其他设备通过它加入并同步。")
            : t("数据保存在这些地方；上传到云端前已在本地加密。")
        }
      >
        {places == null ? (
          <SetRowSkeleton rows={skelRows} lead control="chevron" />
        ) : (
          <>
            {places.map(placeRow)}
            {!hasTargets &&
              (!noOrigin && edge != null && !edge.configured ? (
                <div class="cloud-cta">
                  <div class="cloud-cta-text">
                    <div class="cloud-cta-title">{t("用 Cloudflare 开始")}</div>
                    <div class="cloud-cta-sub">
                      {t("登录后创建 R2 存储桶并部署 Edge，向导会带你在控制台生成访问密钥。")}
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
                    {t("连接 Cloudflare")}
                  </button>
                </div>
              ) : (
                <SetRow
                  lead={<Icon name="bucket" />}
                  title={t("还没有其他同步目标")}
                  caption={t("连接一个存储桶，所有设备通过它交换加密后的工作区数据。")}
                />
              ))}
            {hasTargets && !hasBucket && !noOrigin && (
              <div class="set-managed-note">{t("还没连接存储桶。直连只在两边都在线时同步；存储桶能让离线的设备稍后补齐。")}</div>
            )}
          </>
        )}
      </SetSection>

      {serverScope && <WorkspaceStorageSection scope={serverScope} />}

      <details class="set-disclosure" style={{ marginTop: 22 }}>
        <summary>{t("它是怎么工作的")}</summary>
        <div class="set-disclosure-body">
          {t("存储桶只做中转：每台设备把改动加密后上传，再拉取别人的——不必同时在线，也不需要公网 IP。直连则是两台服务器互相推送，实时但要求两边同时在线。")}
          {desktop
            ? t("这台设备把改动发布到桶，其他设备从桶拉取；新设备扫码加入即可。")
            : noOrigin
              ? t("这台设备把整个工作区发布到桶，新设备扫码加入后从桶恢复。")
              : t("密钥只保存在服务器；信任的设备重输一次密钥即可直连桶，离线、在外也不中断。")}
        </div>
      </details>
    </>
  );
}

/** 附件 + 长期保留副本 — the workspace blob store in two flat sections: the
 *  byte hero with ONE status sentence (a button only when there is something
 *  to clear), then the anchor policy that gates clearing: a row of switches, one
 *  dropdown, one footnote. Placement = scope (doc 19): this IS the server /
 *  desktop-workspace bytes; 离线与缓存 only ever touches browser bytes. */
function WorkspaceStorageSection({ scope }: { scope: Scope }) {
  const [info, setInfo] = useState<BlobCacheInfo | null>(null);
  const [roster, setRoster] = useState<NodeInfo[]>([]);
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
    api.nodes().then(setRoster).catch(() => undefined);
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
      title: t("清理腾出 {bytes}", { bytes: fmtBytes(clearable) }),
      message: t("只删除别处已确认备份的副本，文件不会丢，用到时自动取回。"),
      confirmLabel: t("清理"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.clearBlobCache();
      toast(r.cleared ? t("已腾出 {bytes}（{n} 项）", { bytes: fmtBytes(r.freedBytes), n: r.cleared }) : t("暂时没有可清理的"));
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

  const whereCaption = t("附件原件保存在「{place}」，所有设备共用。", { place: scope.label });
  const policyCaption = t("开启的位置会保留所有附件的完整副本。只要确认这里有备份，其他设备就可以放心清理本地缓存。");
  if (info == null || stats == null) {
    return (
      <>
        <SetSection label={t("附件")} caption={whereCaption}>
          <CacheRingHero loading segs={{ free: 0, keep: 0, pin: 0 }} count={0} totalBytes={0} state="safe" />
        </SetSection>
        <SetSection label={t("长期保留副本")} caption={policyCaption}>
          <SetRowSkeleton rows={2} lead control="switch" />
        </SetSection>
      </>
    );
  }

  const { policy, nodes, buckets } = info;
  const bucketAnchors = [
    ...buckets,
    ...policy.fullNodes
      .filter((a) => a.startsWith("s3://") && !buckets.some((b) => b.url === a))
      .map((url) => ({ url, label: null, bucket: null })),
  ];
  const selfTag = isDesktop() ? t("这台设备") : scope.label;
  const rosterOf = (id: string) => roster.find((n) => n.node_id === id);
  /** Static description: what kind of place this is — the switch carries state. */
  const deviceCaption = (id: string) => {
    const n = rosterOf(id);
    const words = [n?.app && APP_WORD[n.app], n?.platform && PLATFORM_WORD[n.platform]].filter(Boolean);
    return words.length ? words.join(" · ") : t("设备");
  };

  const status = hasFreeable ? (
    <button class="btn btn-secondary" disabled={busy || verifying} onClick={() => void clear()}>
      {t("清理腾出 {bytes}", { bytes: fmtBytes(clearable) })}
    </button>
  ) : (
    <span class="blob-status">
      <Icon name="check" cls="ico sm" />
      {selfIsFull ? t("这里保留全部附件原件，无需清理") : noAnchor ? t("还没指定长期保留的位置") : unverified ? t("核对备份后才能清理") : t("都已备份，暂时没有可清理的")}
    </span>
  );

  const verifiedCopy = verifying
    ? t("核对中…")
    : info.lastVerifiedAt != null
      ? t("上次核对 {ago}", { ago: timeAgo(info.lastVerifiedAt) })
      : t("还没核对过");

  return (
    <>
      <SetSection label={t("附件")} caption={whereCaption}>
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
              {status}
              <button class="btn btn-ghost" onClick={() => openBlobManager(scope)}>
                {t("查看附件…")}
              </button>
            </>
          }
        />
      </SetSection>

      <SetSection label={t("长期保留副本")} caption={policyCaption}>
        {bucketAnchors.map((b) => (
          <SetRow
            key={b.url}
            lead={<Icon name="bucket" />}
            title={<span class="set-row-name">{b.label || b.bucket || b.url}</span>}
            caption={t("云端存储桶")}
            control={<Switch checked={policy.fullNodes.includes(b.url)} disabled={busy} onChange={() => toggleNode(b.url)} />}
          />
        ))}
        {nodes.map((n) => (
          <SetRow
            key={n.nodeId}
            lead={<Icon name={deviceIcon(rosterOf(n.nodeId)?.form)} />}
            title={
              <>
                <span class="set-row-name">{n.label || t("未命名设备")}</span>
                {n.self && <span class="set-row-tag self">{selfTag}</span>}
                {!n.label && <span class="set-row-tag mono">{n.nodeId}</span>}
              </>
            }
            caption={deviceCaption(n.nodeId)}
            control={<Switch checked={policy.fullNodes.includes(n.nodeId)} disabled={busy} onChange={() => toggleNode(n.nodeId)} />}
          />
        ))}
        {policy.fullNodes.length === 0 && (
          <div class="set-managed-note">{t("还没有长期保留的位置。先指定一处，其他设备才能放心清理本地缓存。")}</div>
        )}
        {policy.fullNodes.length > 1 && (
          <SetRow
            title={t("清理前需要几处确认")}
            caption={t("设备清理缓存前，要有几处长期副本确认持有该附件。")}
            control={
              <RowSelect
                value={policy.redundancy}
                disabled={busy || verifying}
                options={[
                  { value: "any", label: t("一处即可"), sublabel: t("任一长期副本确认即可清理") },
                  { value: "all", label: t("每处都要"), sublabel: t("所有长期副本都确认后才清理") },
                ]}
                onChange={(r) => void pickRedundancy(r)}
              />
            }
          />
        )}
        <div class="set-managed-note">
          {verifiedCopy}
          {info.unreachableAnchors.length > 0 && ` · ${t("部分位置连不上，相关文件暂不清理")}`}
          {!verifying && (
            <>
              {" · "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (!busy) void verify(true);
                }}
              >
                {t("重新核对")}
              </a>
            </>
          )}
        </div>
        {info.quotaBytes > 0 && (
          <div class="set-managed-note">
            {t("占用超过 {bytes} 时，自动清理最久没用、已有备份的；你固定的不动。", { bytes: fmtBytes(info.quotaBytes) })}
          </div>
        )}
      </SetSection>
    </>
  );
}
