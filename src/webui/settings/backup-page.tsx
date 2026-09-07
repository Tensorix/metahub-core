/** @jsxImportSource preact */
// 数据与备份 — the workspace page. Health line on top (same derivation as
// `mh status`), then ONE row per sync bucket — a bucket's only home in the UI:
// vendor · region · last sync in the caption, every action (sync / direct-
// connect / key rotation / recovery code / remove) in the row's ⋯ menu. Below,
// the attachment store (bytes + one status sentence) and the long-term copy
// policy (which places keep every attachment), explained once per section, not
// once per row. Data/ownership rules are unchanged from doc 19: origin buckets
// live on the server and are mirrored read-only here; a trusted replica may
// re-enter the secret to sync one directly; no-origin owns its own list.
import { useEffect, useState } from "preact/hooks";
import { api, type S3Peer, type BlobCacheInfo, type EdgeStatus, type DataMap, type NodeInfo } from "../api.ts";
import type { S3Config } from "../../core/sync/storage.ts";
import { Icon } from "../icons.tsx";
import { timeAgo } from "../date.ts";
import {
  dataMapHeadline,
  dataMapIssueLines,
  dataMapTone,
  placeCaption,
  selfPlaceCopy,
  PLACE_KIND_LABEL,
  PLACE_ROLE_LABEL,
} from "../data-map-status.ts";
import { replicaEnabled, onReplicaStatus, isNoOrigin, clientMode, call as replicaCall } from "../data/replica.ts";
import { scopesFor, type Scope } from "../data/scopes.ts";
import { openBlobManager } from "../blob-manager.tsx";
import { openModal, closeModal, toast, confirmDialog } from "../ui.tsx";
import {
  EdgeDeployModal,
  ActivateBucketOnDeviceModal,
  AddStorageModal,
  AddDeviceModal,
  RotateModal,
  RecoveryCodeModal,
} from "./modals.tsx";
import { isDesktop, fmtBytes, providerName, regionName, type StoragePeerView } from "./shared.ts";
import { pageLabel } from "./nav.ts";
import { SetRow, Switch, SetSection, PageHeader, RowMenu } from "./primitives.tsx";
import { CacheRingHero, type RingState } from "./cache-ring.tsx";
import { deviceIcon } from "./devices-page.tsx";

/** One-line workspace data-map summary under the page title: how many places
 *  hold the data and the one thing (if any) needing attention. Same core
 *  derivation as `mh status`. Quiet sub-line — the dot alone carries tone;
 *  查看各处 expands a bordered per-place list with an inline retry on the
 *  place that failed. */
function SyncHealthLine() {
  const [map, setMap] = useState<DataMap | null>(null);
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const tick = () => api.syncHealth().then(setMap).catch(() => undefined);
  useEffect(() => {
    let live = true;
    const t0 = () => api.syncHealth().then((m) => live && setMap(m)).catch(() => undefined);
    t0();
    const t = setInterval(t0, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (!map) return null;
  const tone = dataMapTone(map);
  const selfCopy = selfPlaceCopy(clientMode());
  const retry = async (url: string) => {
    setRetrying(url);
    try {
      if (isNoOrigin()) await replicaCall("sync");
      else await api.syncPeer(url);
    } catch (e) {
      toast(`同步失败：${(e as Error).message}`);
    } finally {
      setRetrying(null);
      void tick();
    }
  };
  return (
    <div class="sync-health">
      <button class="sync-health-line" onClick={() => setOpen((o) => !o)}>
        <span class={`sync-health-dot dot-${tone}`} />
        <span class="sync-health-text">{dataMapHeadline(map)}</span>
        <span class="sync-health-more">{open ? "收起" : "查看各处"}</span>
        <span class={`row-chev${open ? " open" : ""}`}>
          <Icon name="chevronDown" />
        </span>
      </button>
      {dataMapIssueLines(map).length > 1 && (
        <div class="sync-health-issues">
          {dataMapIssueLines(map).map((line) => (
            <div class="sync-health-issue" key={line}>
              {line}
            </div>
          ))}
        </div>
      )}
      {open && (
        <div class="sync-health-places">
          {map.places.map((p) => (
            <div class="sync-health-place" key={p.url ?? "self"}>
              <span class="sync-health-place-kind">
                {p.kind === "self" ? selfCopy.kindLabel : PLACE_KIND_LABEL[p.kind]}
              </span>
              <span class="sync-health-place-label">
                {p.kind === "self" && p.label === "本机" ? (selfCopy.labelOverride ?? p.label) : p.label}
              </span>
              <span class={"sync-health-place-cap" + (p.freshness === "error" ? " cap-err" : "")}>
                {placeCaption(p)}
              </span>
              {p.roles.includes("blob_anchor") && (
                <span class="sync-health-role">{PLACE_ROLE_LABEL.blob_anchor}</span>
              )}
              {p.freshness === "error" && p.url && (
                <button class="btn btn-ghost sm" disabled={retrying === p.url} onClick={() => void retry(p.url!)}>
                  {retrying === p.url ? "重试中…" : "重试"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function BackupPage() {
  const noOrigin = isNoOrigin();
  const desktop = isDesktop();
  // The workspace's blob store scope (云端工作区 / desktop 本机工作区). Absent
  // exactly in no-origin cells — those keep bytes only in the browser replica.
  const serverScope = scopesFor(clientMode()).find((s) => s.kind === "server");
  const [enabled, setEnabled] = useState(replicaEnabled());
  const [serverPeers, setServerPeers] = useState<S3Peer[] | null>(null);
  const [localPeers, setLocalPeers] = useState<StoragePeerView[] | null>(null);
  const [edge, setEdge] = useState<EdgeStatus | null>(null);
  // Bucket roles from the data map (工作区同步 / 附件长期保存 / 发布快照) —
  // same derivation the sync header uses, keyed by peer url.
  const [rolesByUrl, setRolesByUrl] = useState<Map<string, string[]>>(() => new Map());

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
    api
      .syncHealth()
      .then((m) =>
        setRolesByUrl(
          new Map(
            m.places
              .filter((pl) => pl.url != null && pl.kind === "bucket")
              .map((pl) => [pl.url!, pl.roles.map((r) => PLACE_ROLE_LABEL[r])]),
          ),
        ),
      )
      .catch(() => undefined);
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
      title: `停止使用 ${name}`,
      message: "将停止与它同步。桶内数据不受影响，可以随时重新连接。",
      confirmLabel: "停止使用",
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
      title: "停止此浏览器直连",
      message: `此浏览器将不再直连 ${name}。存储桶仍在服务器上；此浏览器在线时照常经服务器同步。`,
      confirmLabel: "停止直连",
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

  /** vendor · region · last sync (· direct) — or the failure, in red. */
  const rowCaption = (
    p: { endpoint?: string | null; region?: string | null; provider?: string | null; lastSyncAt: number | null; status: string | null; error: string | null },
    direct: boolean,
  ) => {
    if (p.status === "error" && p.error)
      return (
        <>
          <span class="cap-dot err" />
          <span class="cap-err">同步失败 · {p.error}</span>
        </>
      );
    const parts = [
      providerName(p.provider, p.endpoint),
      regionName(p.region),
      p.lastSyncAt ? `上次同步 ${timeAgo(p.lastSyncAt)}` : "还没同步过",
      direct ? (noOrigin ? "本机发布" : "此浏览器已直连") : null,
    ].filter(Boolean);
    return (
      <>
        <span class={"cap-dot " + (p.lastSyncAt ? "ok" : "")} />
        {parts.join(" · ")}
      </>
    );
  };

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
        caption={
          noOrigin
            ? "这台设备的云端后端，其他设备通过它加入并同步。"
            : desktop
              ? "工作区的云端后端，所有设备通过它交换加密后的数据。"
              : "工作区的云端后端，保存在服务器上，所有设备通过它交换加密后的数据。"
        }
      >
        {list == null ? (
          <div class="muted">加载中…</div>
        ) : list.length === 0 ? (
          !noOrigin && edge != null && !edge.configured ? (
            <div class="cloud-cta">
              <div class="cloud-cta-text">
                <div class="cloud-cta-title">连接 Cloudflare</div>
                <div class="cloud-cta-sub">
                  登录后可部署 Edge，并可选择创建一个 R2 桶。R2 接入还需要在 Cloudflare
                  控制台创建 S3 凭据并设置加密口令；向导会分步引导，不会声称已自动完成。
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
              lead={<Icon name="bucket" />}
              title="还没连接存储桶"
              caption="连接一个同步存储桶，让各设备交换加密后的工作区数据。"
              control={<button class="btn btn-primary" onClick={add}>连接存储桶</button>}
            />
          )
        ) : (
          <>
            {list.map((p) => {
              const name = p.label || p.bucket || p.url;
              const onDevice = !noOrigin && replicaOn && localUrls.has(p.url);
              const sp = p as S3Peer;
              const failed = p.status === "error" && !!p.error;
              return (
                <SetRow
                  key={p.url}
                  lead={<Icon name="bucket" />}
                  title={
                    <>
                      <span class="set-row-name">{name}</span>
                      {(rolesByUrl.get(p.url) ?? []).map((r) => (
                        <span class="set-row-tag accent" key={r}>
                          {r}
                        </span>
                      ))}
                    </>
                  }
                  caption={rowCaption(p, noOrigin || onDevice)}
                  control={
                    <>
                      {failed && !noOrigin && (
                        <button class="btn btn-ghost sm" onClick={() => rotateBucket(sp)}>
                          更换密钥…
                        </button>
                      )}
                      <RowMenu
                        items={[
                          { icon: "refresh", label: "立即同步", onClick: () => void syncBucket(p.url) },
                          ...(!noOrigin && replicaOn && !onDevice
                            ? [{ icon: "link", label: "让此浏览器可离线同步", sublabel: "服务器连不上时也能同步", onClick: () => activateHere(sp) }]
                            : []),
                          ...(onDevice
                            ? [{ icon: "link", label: "停止此浏览器直连", onClick: () => void detachHere(p.url, name) }]
                            : []),
                          ...(!noOrigin
                            ? [
                                { icon: "key", label: "更换存储密钥…", sublabel: "设备丢失或密钥泄露时", onClick: () => rotateBucket(sp) },
                                { icon: "copy", label: "导出恢复码…", onClick: () => recoveryBucket(sp) },
                              ]
                            : []),
                          { icon: "trash", label: "停止使用此存储桶", danger: true, onClick: () => void removeBucket(p.url, name) },
                        ]}
                      />
                    </>
                  }
                />
              );
            })}
            <button class="add-row" onClick={add}>
              <Icon name="plus" />
              连接存储桶
            </button>
            {noOrigin && bucketList.length > 0 && (
              <button class="add-row" onClick={addDevice}>
                <Icon name="plus" />
                添加设备
              </button>
            )}
          </>
        )}
      </SetSection>

      {serverScope && <WorkspaceStorageSection scope={serverScope} />}

      <details class="set-disclosure" style={{ marginTop: 22 }}>
        <summary>它是怎么工作的</summary>
        <div class="set-disclosure-body">
          存储桶只做“哑”中转：每台设备把自己的改动加密后上传，再拉取别人的——谁都不必同时在线，也不需要公网 IP。
          {desktop
            ? "这台设备把自己的改动发布到桶，其他设备从桶拉取；新设备扫码加入即可一起同步。"
            : noOrigin
              ? "这台设备把整个工作区发布到桶，新设备扫码加入后从桶秒恢复。"
              : "密钥只保存在服务器，不会同步到浏览器；信任的设备重输一次密钥即可直连，离线、在外也不中断。添加时会自动为本站点开通桶的访问权限（CORS）。"}
        </div>
      </details>
    </>
  );
}

/** 附件 + 长期保留副本 — the workspace blob store in two flat sections: the
 *  byte hero with ONE status sentence (a button only when there is something
 *  to clear), then the anchor policy that gates clearing, explained once in the
 *  section caption. Placement = scope (doc 19): this IS the server /
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
      title: `清理腾出 ${fmtBytes(clearable)}`,
      message: "只删除别处已确认备份的副本，文件不会丢，用到时自动取回。",
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

  const whereCaption = `附件原件保存在「${scope.label}」，所有设备共用。`;
  if (info == null || stats == null) {
    return (
      <SetSection label="附件" caption={whereCaption}>
        <SetRow title="占用" caption="加载中…" />
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
  const selfTag = isDesktop() ? "这台设备" : scope.label;
  const formOf = (id: string) => roster.find((n) => n.node_id === id)?.form ?? null;

  const status = hasFreeable ? (
    <button class="btn btn-secondary" disabled={busy || verifying} onClick={() => void clear()}>
      清理腾出 {fmtBytes(clearable)}
    </button>
  ) : (
    <span class="blob-status">
      <Icon name="check" cls="ico sm" />
      {selfIsFull ? "这里保留全部附件原件，无需清理" : noAnchor ? "还没指定长期保留的位置" : unverified ? "核对备份后才能清理" : "都已备份，暂时没有可清理的"}
    </span>
  );

  return (
    <>
      <SetSection label="附件" caption={whereCaption}>
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
                查看附件…
              </button>
            </>
          }
        />
      </SetSection>

      <SetSection
        label="长期保留副本"
        caption="开启的位置会保留所有附件的完整副本。只要确认这里有备份，其他设备就可以放心清理本地缓存。"
      >
        {bucketAnchors.map((b) => {
          const on = policy.fullNodes.includes(b.url);
          return (
            <SetRow
              key={b.url}
              lead={<Icon name="bucket" />}
              title={
                <>
                  <span class="set-row-name">{b.label || b.bucket || b.url}</span>
                  <span class="set-row-tag">云端</span>
                </>
              }
              caption={on ? "附件会长期保存在云端" : "开启后，附件会长期保存在云端"}
              control={<Switch checked={on} disabled={busy} onChange={() => toggleNode(b.url)} />}
            />
          );
        })}
        {nodes.map((n) => {
          const on = policy.fullNodes.includes(n.nodeId);
          return (
            <SetRow
              key={n.nodeId}
              lead={<Icon name={deviceIcon(formOf(n.nodeId))} />}
              title={
                <>
                  <span class="set-row-name">{n.label || "未命名设备"}</span>
                  {n.self && <span class="set-row-tag self">{selfTag}</span>}
                  {!n.label && <span class="set-row-tag mono">{n.nodeId}</span>}
                </>
              }
              caption={on ? "保留全部副本" : "未保留"}
              control={<Switch checked={on} disabled={busy} onChange={() => toggleNode(n.nodeId)} />}
            />
          );
        })}
        {policy.fullNodes.length === 0 && (
          <div class="set-managed-note">还没有长期保留的位置。先指定一处，其他设备才能放心清理本地缓存。</div>
        )}
        {policy.fullNodes.length > 1 && (
          <SetRow
            title="清理前需要几处确认"
            caption="设备清理缓存前，要有几处长期副本确认持有该附件。"
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
              ? "核对中…"
              : info.lastVerifiedAt != null
                ? `上次核对 ${timeAgo(info.lastVerifiedAt)}`
                : "还没核对过") +
            (info.unreachableAnchors.length > 0 ? " · 部分位置连不上，相关文件暂不清理" : "")
          }
          control={
            <button class="btn btn-ghost" disabled={busy || verifying} onClick={() => void verify(true)}>
              <Icon name="refresh" cls="ico sm" />
              重新核对
            </button>
          }
        />
        {info.quotaBytes > 0 && (
          <div class="set-managed-note">
            占用超过 {fmtBytes(info.quotaBytes)} 时，自动清理最久没用、已有备份的；你固定的不动。
          </div>
        )}
      </SetSection>
    </>
  );
}
