/** @jsxImportSource preact */
// Share dialog: ① create a new share — pick the target (this server, a paired
// peer server, or an attached object-storage bucket), permission (edit is
// server-only), optional password + expiry; ② see & manage this object's
// existing shares (copy / renew / revoke / open). Mounted imperatively
// (openShareModal) so entry points are a one-liner from any menu.

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  api,
  type ShareTargetOpt,
  type ShareListItem,
  type CreateShareBody,
  type GrantOp,
  type GrantSet,
  type EdgeStatus,
  type Site,
  type SiteHostingInfo,
} from "./api.ts";
import { buildShareTargets, shareTargetUrl } from "./data/share-targets.ts";
import { onReplicaStatus } from "./data/replica.ts";
import type { Scope } from "./data/scopes.ts";
import { isNoOrigin } from "./data/replica.ts";
import {
  siteChannelInput,
  siteChannels,
  CHANNEL_STATUS_LABEL,
  type SiteChannel,
} from "./site-status.ts";
import { confirmDialog } from "./ui.tsx";

export interface ShareTarget {
  kind: "doc" | "database" | "site";
  ref: string; // the target's id (used as target_id)
  title?: string;
}

/** Broadcast after any create/revoke/renew so the global view + in-context
 *  "shared" badges (useSharedTargets) refresh — mirrors NAV_INVALIDATE. */
export const SHARES_CHANGED = "mh-shares-changed";
export function notifySharesChanged(): void {
  document.dispatchEvent(new Event(SHARES_CHANGED));
}

/** The set of target ids that currently have at least one share — drives the
 *  in-context "已分享" badges. One GET on mount, refreshed on SHARES_CHANGED. */
export function useSharedTargets(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .listLocalShares()
        .then((list) => alive && setIds(new Set(list.map((s) => s.target_id))))
        .catch(() => undefined);
    load();
    document.addEventListener(SHARES_CHANGED, load);
    return () => {
      alive = false;
      document.removeEventListener(SHARES_CHANGED, load);
    };
  }, []);
  return ids;
}

/** Copy / renew / revoke handlers shared by the modal's ShareRows and the global
 *  ShareView. Broadcasts SHARES_CHANGED + reloads after a mutation. */
export function useShareActions(
  reload: () => void,
  onFlash: (s: string) => void,
  onError: (s: string) => void,
) {
  const copyShare = async (s: ShareListItem) => {
    if (s.url) {
      copy(s.url);
      onFlash("链接已复制");
      return;
    }
    try {
      const r = await api.renewShare(s.slug); // s3 link isn't stored — re-presign
      copy(r.url);
      onFlash("已重新生成并复制链接");
      notifySharesChanged();
      reload();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const revoke = async (s: ShareListItem) => {
    if (!confirm(`撤销这个分享？(${s.source})`)) return;
    try {
      const result = await api.revokeShare(s.slug, s.sourceUrl);
      if (result.status === "cleanup_pending") {
        onError("撤销已提交，但 Edge 尚未确认销毁 Room；本地保留管理记录并会继续重试。");
        notifySharesChanged();
        reload();
        return;
      }
      onFlash("已撤销");
      notifySharesChanged();
      reload();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const renew = async (s: ShareListItem) => {
    try {
      const r = await api.renewShare(s.slug);
      copy(r.url);
      onFlash("已续期 7 天，新链接已复制");
      notifySharesChanged();
      reload();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return { copyShare, revoke, renew };
}

export function openShareModal(target: ShareTarget): void {
  injectStyle();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const close = () => {
    render(null, host);
    host.remove();
  };
  render(<ShareModal target={target} onClose={close} />, host);
}

const EXPIRY: { label: string; ms: number | null }[] = [
  { label: "永不过期", ms: null },
  { label: "1 小时", ms: 3_600_000 },
  { label: "24 小时", ms: 86_400_000 },
  { label: "7 天", ms: 604_800_000 },
  { label: "30 天", ms: 2_592_000_000 },
];

/** The ordered share targets as unified Scopes (current server default, then
 *  peer servers, then attached buckets). Seeded synchronously so the picker has
 *  a value before the async load; refreshed when a bucket is attached/detached
 *  on this device (onReplicaStatus). The visible <select> stays native — it sits
 *  inside the share overlay's own stacking context and keeps the per-option
 *  "（站点不支持）" disabling that a popup menu can't express. */
function useShareTargets(): Scope[] {
  const [targets, setTargets] = useState<Scope[]>(() => buildShareTargets([], [], location.origin));
  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([api.listShareServers().catch(() => []), api.listShareBuckets().catch(() => [])]).then(
        ([servers, buckets]: [ShareTargetOpt[], ShareTargetOpt[]]) => {
          if (alive) setTargets(buildShareTargets(servers, buckets, location.origin));
        },
      );
    load();
    const off = onReplicaStatus(() => load());
    return () => {
      alive = false;
      off();
    };
  }, []);
  return targets;
}

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** Per-database grant edits for a site share: dbId → enabled ops. */
type GrantDraft = Map<string, Set<GrantOp>>;

function draftToGrantSet(draft: GrantDraft): GrantSet | null {
  const tables = [...draft.entries()]
    .filter(([, ops]) => ops.size > 0)
    .map(([db, ops]) => ({
      db,
      ops: (["read", "create", "update"] as GrantOp[]).filter((o) => ops.has(o)),
    }));
  return tables.length ? { v: 1, tables } : null;
}

function ShareModal({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const targets = useShareTargets();
  const [selId, setSelId] = useState("server");
  const [access, setAccess] = useState<"private" | "public" | "link">("link");
  // Hosting is DERIVED by default (audience is the user's decision, the
  // mechanism is ours); "更改" flips hostingAuto off and exposes the selects.
  const [hostingAuto, setHostingAuto] = useState(true);
  const [hosting, setHosting] = useState<"device" | "edge">(
    isNoOrigin() ? "edge" : "device",
  );
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [password, setPassword] = useState("");
  const [expiryIdx, setExpiryIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shares, setShares] = useState<ShareListItem[]>([]);
  const [flash, setFlash] = useState("");
  // Data grants (site shares over the server transport): which tables the
  // link's pages may read/write through /share/<slug>/api/*.
  const [dbs, setDbs] = useState<{ id: string; name: string }[]>([]);
  const [grantDraft, setGrantDraft] = useState<GrantDraft>(() => new Map());
  const [showGrants, setShowGrants] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [edge, setEdge] = useState<EdgeStatus | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [siteHosting, setSiteHosting] = useState<SiteHostingInfo | null>(null);
  const [resultUrl, setResultUrl] = useState("");

  const refreshSiteState = () => {
    if (target.kind !== "site") return;
    api.listSites().then((list) => setSite(list.find((s) => s.id === target.ref) ?? null)).catch(() => undefined);
    if (!isNoOrigin()) api.getSiteHosting().then(setSiteHosting).catch(() => setSiteHosting(null));
  };

  useEffect(() => {
    refreshShares();
    if (target.kind === "site") {
      api.listDatabases().then((list) => setDbs(list.map((d) => ({ id: d.id, name: d.name })))).catch(() => undefined);
      api.getEdgeStatus().then(setEdge).catch(() => setEdge(null));
      refreshSiteState();
    }
  }, []);

  const grantedCount = [...grantDraft.values()].filter((ops) => ops.size > 0).length;

  const toggleGrant = (dbId: string, op: GrantOp) => {
    setGrantDraft((cur) => {
      const next = new Map(cur);
      const ops = new Set(next.get(dbId) ?? []);
      if (ops.has(op)) ops.delete(op);
      else ops.add(op);
      next.set(dbId, ops);
      return next;
    });
  };

  function refreshShares() {
    api.listShares({ target: target.ref }).then(setShares).catch(() => undefined);
  }

  const stopPublic = async () => {
    const ok = await confirmDialog({
      title: "停止公开访问？",
      message:
        "任何人将无法再通过公开地址访问这个站点；已有的分享链接不受影响。浏览器或 CDN 缓存可能仍保留数分钟。",
      confirmLabel: "停止公开",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError("");
    try {
      if (isNoOrigin()) await api.updateSite(target.ref, { visibility: "private" });
      else await api.publishSite({ siteId: target.ref, access: "private" });
      setFlash("已停止公开访问");
      notifySharesChanged();
      refreshSiteState();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const siteKind = target.kind === "site";
  const deviceTargets = targets.filter(
    (t) => t.kind === "server" && (!isNoOrigin() || t.id !== "server"),
  );
  const sel = targets.find((t) => t.id === selId) ?? deviceTargets[0] ?? targets[0];
  const s3 = !siteKind && sel?.kind === "bucket";

  // ── hosting derivation (sites) ────────────────────────────────────────────
  // The user's decision is the audience; the mechanism is derived: a usable
  // always-on Edge wins, else a device with a verified entry, else Edge again
  // so the guidance below points at the universal fix. "更改" opts out.
  const edgeUsable = !!edge?.configured && !!edge.capabilities?.includes("room");
  const serverEntryOk = !!siteHosting?.publicBaseUrl;
  const autoDevice = serverEntryOk
    ? (targets.find((t) => t.id === "server") ?? deviceTargets[0])
    : deviceTargets.find((t) => t.id !== "server") ?? deviceTargets[0];
  const deviceUsable =
    !isNoOrigin() && !!autoDevice && (autoDevice.id !== "server" || serverEntryOk);
  const autoHosting: "device" | "edge" = edgeUsable ? "edge" : deviceUsable ? "device" : "edge";
  const effHosting = !siteKind ? hosting : hostingAuto ? autoHosting : hosting;
  const effSel = siteKind && hostingAuto && effHosting === "device" ? (autoDevice ?? sel) : sel;

  // Dead-end prevention: figure out up front why the chosen hosting can't work,
  // show inline guidance with a way out instead of throwing on submit. The
  // matching throws in create() stay as backstops only.
  const hostingActive = siteKind && access !== "private";
  const deviceBlocked = !hostingActive || effHosting !== "device"
    ? ""
    : isNoOrigin()
      ? "此设备把数据存放在云端存储桶、不常驻在线，无法托管站点。"
      : deviceTargets.length === 0
        ? "没有可托管站点的设备。"
        : effSel?.id === "server" && !serverEntryOk
          ? "当前设备还没有配置公网或局域网入口，访客将无法访问。"
          : "";
  const edgeBlocked = !hostingActive || effHosting !== "edge"
    ? ""
    : edge === null
      ? "" // status still loading — don't flash a warning
      : !edge.configured
        ? "还没有连接 Edge。部署到你自己的 Cloudflare 后，站点始终在线，你的设备关机也能访问。"
        : !edge.capabilities?.includes("room")
          ? "当前 Edge 端点仅支持数据收件（inbox），不能托管站点；重新部署官方 Edge Worker 即可启用。"
          : "";
  const hostingBlocked = deviceBlocked || edgeBlocked;
  const gotoSettings = (sec: string) => {
    onClose();
    location.hash = `#/settings?sec=${sec}`;
  };

  // Public (token-free) channels of this site — publish states, rollbacks, or
  // the honest "public but unverified" placeholder. Link channels stay in the
  // shares list below; together they form the 访问渠道 section.
  const publicChannels: SiteChannel[] =
    siteKind && site ? siteChannels(siteChannelInput(site, [], siteHosting)) : [];
  useEffect(() => {
    if (s3 && permission === "edit") setPermission("view");
  }, [s3]);
  const expiryOpts = s3 ? EXPIRY.filter((e) => e.ms == null || e.ms <= 604_800_000) : EXPIRY;
  const eIdx = Math.min(expiryIdx, expiryOpts.length - 1);

  async function create() {
    if (s3 && siteKind) {
      setError("站点不支持存储桶分享，请选设备或 Edge。");
      return;
    }
    setBusy(true);
    setError("");
    setResultUrl("");
    try {
      const grantSet = siteKind ? draftToGrantSet(grantDraft) : null;
      if (siteKind && access === "private") {
        if (isNoOrigin()) await api.updateSite(target.ref, { visibility: "private" });
        else await api.publishSite({ siteId: target.ref, access: "private" });
        setFlash("已关闭直接公开访问；已有分享链接不会自动撤销");
        notifySharesChanged();
        refreshSiteState();
        return;
      }

      if (siteKind && effHosting === "device" && isNoOrigin())
        throw new Error("此设备把数据存放在云端存储桶、不常驻在线，无法托管站点，请选择 Edge");
      if (siteKind && effHosting === "edge" && !edge?.configured)
        throw new Error("请先在“设置 → 站点托管”连接或部署 Edge");
      if (siteKind && effHosting === "edge" && !edge?.capabilities?.includes("room"))
        throw new Error("当前 Edge 端点仅支持数据收件（inbox），不能托管站点");
      if (
        siteKind &&
        effHosting === "device" &&
        effSel?.id === "server" &&
        !siteHosting?.publicBaseUrl
      )
        throw new Error("请先在“设置 → 站点托管”配置当前设备的公网或局域网入口");

      if (siteKind && access === "public") {
        const tableCount = grantSet?.tables.length ?? 0;
        const device = effHosting === "device";
        const ok = await confirmDialog({
          title: device ? "确认公开发布到设备？" : "确认公开发布到 Edge？",
          message: device
            ? `任何人无需登录即可访问。持有同一数据并运行托管服务的配对设备也可能公开提供此站点；改回私有后，浏览器或 CDN 缓存仍可能保留数分钟。数据授权：${tableCount} 个数据库。设备必须保持在线。`
            : `任何人无需登录即可访问，链接无口令且永不过期。Edge 会在你的设备离线后继续提供最后一次同步的内容。数据授权：${tableCount} 个数据库。`,
          confirmLabel: "确认公开发布",
          danger: true,
        });
        if (!ok) return;
      }

      if (siteKind && access === "public" && effHosting === "device") {
        const targetBase =
          effSel?.id === "server"
            ? undefined
            : effSel
              ? shareTargetUrl(effSel, location.origin)
              : undefined;
        const published = await api.publishSite({
          siteId: target.ref,
          access: "public",
          grants: grantSet ?? { v: 1, tables: [] },
          targetBase,
        });
        if (published.status === "rollback_pending") {
          setError(
            `发布失败，目标设备的回滚尚未确认；在确认前它可能仍可公开访问。${published.error ? ` ${published.error}` : ""}`,
          );
          setSiteHosting(await api.getSiteHosting().catch(() => siteHosting));
          notifySharesChanged();
          return;
        }
        if (!published.url) throw new Error("发布未返回访问地址");
        if (published.status === "ready") {
          copy(published.url);
          setResultUrl(published.url);
          setFlash("站点已上线，地址已复制");
        } else {
          setFlash("正在同步到目标设备；确认地址可访问后才会视为发布成功");
        }
        notifySharesChanged();
        refreshSiteState();
        return;
      }

      const edgeHosting = siteKind && effHosting === "edge";
      const effectivePassword = siteKind && access === "public" ? null : password || null;
      const effectiveExpiry =
        siteKind && access === "public" ? null : expiryOpts[eIdx]?.ms ?? null;
      const server =
        edgeHosting
          ? null
          : siteKind && effSel?.id === "server"
            ? siteHosting?.publicBaseUrl ?? null
            : effSel
              ? shareTargetUrl(effSel, location.origin)
              : null;
      const body: CreateShareBody = {
        kind: target.kind,
        ref: target.ref,
        transport: s3 ? "s3" : "server",
        hosting: edgeHosting ? "room" : "server",
        permission,
        password: effectivePassword,
        expiresMs: effectiveExpiry,
        server: s3 ? null : server,
        bucketUrl: s3 && sel ? shareTargetUrl(sel, location.origin) : null,
        grants: grantSet ? JSON.stringify(grantSet) : null,
      };
      const r = await api.createShare(body);
      copy(r.url);
      setResultUrl(r.url);
      setFlash(`已通过「${r.source}」上线，地址已复制`);
      setPassword("");
      notifySharesChanged();
      refreshShares();
    } catch (e) {
      setError((e as Error).message || "创建失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="mhshare-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="mhshare-modal">
        <div class="mhshare-head">
          <h2>{siteKind ? "发布与分享" : "分享"}{target.title ? `：${target.title}` : ""}</h2>
          <button class="mhshare-x" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div class="mhshare-body">
          <div class="mhshare-section">{siteKind ? "谁可以访问？" : "新建分享"}</div>
          {siteKind && (
            <div class="mhshare-access" role="radiogroup" aria-label="谁可以访问">
              {(
                [
                  {
                    v: "link",
                    t: "有链接的人",
                    d: "链接无法被猜到；可加口令和有效期。",
                  },
                  {
                    v: "public",
                    t: "任何人",
                    d: "无需登录即可访问；公开状态会同步到你的所有设备。",
                  },
                  {
                    v: "private",
                    t: "仅自己",
                    d: "停止直接公开；已有分享链接不会自动撤销。",
                  },
                ] as const
              ).map((o) => (
                <label key={o.v} class={"mhshare-acard" + (access === o.v ? " sel" : "")}>
                  <input
                    type="radio"
                    name="mh-access"
                    checked={access === o.v}
                    onChange={() => setAccess(o.v)}
                  />
                  <span class="mhshare-acard-t">{o.t}</span>
                  <span class="mhshare-acard-d">{o.d}</span>
                </label>
              ))}
            </div>
          )}
          {!siteKind && (
            <label class="mhshare-field">
              <span>托管</span>
              <select
                value={sel?.id}
                onChange={(e) =>
                  setSelId((e.currentTarget as HTMLSelectElement).value)
                }
              >
                {targets.map((t) => (
                  <option value={t.id}>{t.label} — {t.subtitle}</option>
                ))}
              </select>
            </label>
          )}
          {siteKind && access !== "private" && hostingAuto && (
            <div class="mhshare-field">
              <span>托管</span>
              <div class="mhshare-hostsum">
                <span>
                  {effHosting === "edge"
                    ? "Edge 始终在线 — 你的设备离线也能访问"
                    : `设备在线托管 — ${effSel?.label ?? "本机"}，需保持在线`}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setHosting(effHosting);
                    if (effSel) setSelId(effSel.id);
                    setHostingAuto(false);
                  }}
                >
                  更改
                </button>
              </div>
            </div>
          )}
          {siteKind && access !== "private" && !hostingAuto && (
            <label class="mhshare-field">
              <span>托管</span>
              <select
                value={hosting}
                onChange={(e) =>
                  setHosting(
                    (e.currentTarget as HTMLSelectElement).value as "device" | "edge",
                  )
                }
              >
                <option value="device" disabled={isNoOrigin() || deviceTargets.length === 0}>
                  设备在线托管{isNoOrigin() ? "（此设备无法托管）" : ""}
                </option>
                <option
                  value="edge"
                  disabled={!edge?.configured || !edge.capabilities?.includes("room")}
                >
                  Edge 始终在线
                  {edge?.configured
                    ? edge.capabilities?.includes("room")
                      ? ""
                      : "（当前端点仅支持 inbox）"
                    : "（请先配置）"}
                </option>
              </select>
            </label>
          )}
          {siteKind && access !== "private" && !hostingAuto && hosting === "device" && (
            <label class="mhshare-field">
              <span>设备</span>
              <select
                value={sel?.id}
                onChange={(e) => setSelId((e.currentTarget as HTMLSelectElement).value)}
              >
                {deviceTargets.map((t) => (
                  <option value={t.id}>{t.label} — {t.subtitle}</option>
                ))}
              </select>
            </label>
          )}
          {hostingBlocked && (
            <div class="mhshare-guide">
              <p>{hostingBlocked}</p>
              <div class="mhshare-guide-actions">
                {deviceBlocked && edge?.configured && edge.capabilities?.includes("room") && (
                  <button type="button" onClick={() => setHosting("edge")}>改用 Edge 托管</button>
                )}
                <button type="button" onClick={() => gotoSettings("hosting")}>前往设置 → 站点托管</button>
                {deviceBlocked && isNoOrigin() && (
                  <button type="button" class="mhshare-guide-link" onClick={() => gotoSettings("sync")}>
                    了解此设备的同步方式
                  </button>
                )}
              </div>
            </div>
          )}
          {(!siteKind || access === "link") && <label class="mhshare-field">
            <span>权限</span>
            <select value={permission} disabled={s3} onChange={(e) => setPermission((e.currentTarget as HTMLSelectElement).value as "view" | "edit")}>
              <option value="view">只读</option>
              <option value="edit">可编辑{s3 ? "（仅服务器）" : ""}</option>
            </select>
          </label>}
          {(!siteKind || access === "link") && <label class="mhshare-field">
            <span>口令</span>
            <input type="password" placeholder="可选" value={password} onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)} />
          </label>}
          {(!siteKind || access === "link") && <label class="mhshare-field">
            <span>有效期</span>
            <select value={String(eIdx)} onChange={(e) => setExpiryIdx(Number((e.currentTarget as HTMLSelectElement).value))}>
              {expiryOpts.map((o, i) => (
                <option value={String(i)}>{o.label}</option>
              ))}
            </select>
          </label>}
          {siteKind && access !== "private" && (
            <div class="mhshare-grants">
              <button class="mhshare-adv" type="button" onClick={() => setShowGrants(!showGrants)}>
                {showGrants
                  ? "收起数据授权"
                  : grantedCount > 0
                    ? `数据授权：已开启 ${grantedCount} 张表…`
                    : "高级：数据授权（让页面读写数据）…"}
              </button>
              {showGrants && (
                <>
                  <p class="mhshare-note">
                    页面内的数据接口（<code>api/…</code>）默认关闭。若这个站点需要访客读取或提交数据，在这里按表开启。
                  </p>
                  {dbs.length === 0 ? (
                    <p class="mhshare-note">（没有可授权的数据库）</p>
                  ) : (
                    <ul class="mhshare-grantlist">
                      {dbs.map((d) => {
                        const ops = grantDraft.get(d.id) ?? new Set<GrantOp>();
                        return (
                          <li key={d.id}>
                            <span class="mhshare-grantdb">{d.name}</span>
                            <label>
                              <input type="checkbox" checked={ops.has("read")} onChange={() => toggleGrant(d.id, "read")} /> 读
                            </label>
                            <label>
                              <input type="checkbox" checked={ops.has("create")} onChange={() => toggleGrant(d.id, "create")} /> 新增
                            </label>
                            {showAdvanced && (
                              <label>
                                <input type="checkbox" checked={ops.has("update")} onChange={() => toggleGrant(d.id, "update")} /> 修改
                              </label>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <button class="mhshare-adv" type="button" onClick={() => setShowAdvanced(!showAdvanced)}>
                    {showAdvanced ? "收起高级选项" : "高级：允许修改已有行…"}
                  </button>
                </>
              )}
            </div>
          )}
          {error && <p class="mhshare-err">{error}</p>}
          {flash && <p class="mhshare-ok">{flash}</p>}
          {resultUrl && (
            <div class="mhshare-result">
              <code>{resultUrl}</code>
              <button onClick={() => copy(resultUrl)}>复制</button>
              <a href={resultUrl} target="_blank" rel="noreferrer">打开</a>
            </div>
          )}
          {siteKind && effHosting === "device" && access !== "private" && (
            <p class="mhshare-note">托管设备必须保持在线；公开状态会随工作区同步到其他运行托管服务的节点。</p>
          )}
          {siteKind && effHosting === "edge" && access !== "private" && (
            <p class="mhshare-note">Edge 会持续提供最后一次同步的版本；你的设备离线期间，站点内容停留在最后一次同步的状态。</p>
          )}
          <div class="mhshare-foot">
            <button onClick={onClose}>关闭</button>
            <button class="mhshare-primary" disabled={busy || !!hostingBlocked} onClick={create}>
              {busy ? "发布中…" : access === "private" && siteKind ? "保存" : "发布并复制地址"}
            </button>
          </div>

          {siteKind ? (
            <>
              <div class="mhshare-section">访问渠道（{publicChannels.length + shares.length}）</div>
              {publicChannels.map((c) => (
                <PublicChannelRow
                  key={c.url ?? "unverified"}
                  channel={c}
                  onStop={stopPublic}
                  onFlash={setFlash}
                />
              ))}
              <ShareRows
                shares={shares}
                reload={refreshShares}
                onFlash={setFlash}
                onError={setError}
                empty={
                  publicChannels.length
                    ? "没有链接分享。"
                    : "还没有任何访问渠道 — 在上面选择受众并发布即可生成。"
                }
              />
            </>
          ) : (
            <>
              <div class="mhshare-section">已有分享（{shares.length}）</div>
              <ShareRows shares={shares} reload={refreshShares} onFlash={setFlash} onError={setError} empty="还没有分享这个对象。" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** One row per token-free (public) channel of a site: publish state, pending
 *  rollback, or the honest "public but unverified" placeholder. Link shares
 *  render via ShareRows below — together they form the 访问渠道 list. */
function PublicChannelRow({
  channel: c,
  onStop,
  onFlash,
}: {
  channel: SiteChannel;
  onStop: () => void;
  onFlash: (s: string) => void;
}) {
  return (
    <ul class="mhshare-list">
      <li>
        <div class="mhshare-li-main">
          <span class="mhshare-badge mhshare-badge-pub">公开</span>
          <span class="mhshare-src">{c.url ?? "任何人可访问"}</span>
          <span class="mhshare-meta">
            {CHANNEL_STATUS_LABEL[c.status]}
            {c.status === "unverified" ? "（本设备未记录已验证入口）" : ""}
          </span>
        </div>
        <div class="mhshare-li-actions">
          {c.url && (
            <>
              <button
                onClick={() => {
                  copy(c.url!);
                  onFlash("链接已复制");
                }}
              >
                复制
              </button>
              <a href={c.url} target="_blank" rel="noreferrer">
                打开
              </a>
            </>
          )}
          <button class="mhshare-danger" onClick={onStop}>
            停止公开
          </button>
        </div>
      </li>
    </ul>
  );
}

/** Reusable list of shares with copy / renew / revoke / open actions (per-target
 *  in the share modal, and global in the manager). */
function ShareRows({
  shares,
  reload,
  onFlash,
  onError,
  empty,
}: {
  shares: ShareListItem[];
  reload: () => void;
  onFlash: (s: string) => void;
  onError: (s: string) => void;
  empty: string;
}) {
  const { copyShare, revoke, renew } = useShareActions(reload, onFlash, onError);
  if (shares.length === 0) return <p class="mhshare-note">{empty}</p>;
  return (
    <ul class="mhshare-list">
      {shares.map((s) => (
        <li key={s.slug}>
          <div class="mhshare-li-main">
            <span class="mhshare-badge">
              {s.hosting === "room" ? "Edge" : s.transport === "s3" ? "存储桶" : "设备"}
            </span>
            <span class="mhshare-src">{s.source}</span>
            <span class="mhshare-meta">
              {s.lifecycle === "cleanup_pending"
                ? "撤销待确认"
                : s.lifecycle === "provisioning"
                  ? "正在创建"
                  : s.permission === "edit"
                    ? "可编辑"
                    : "只读"}
              {s.hasPassword ? " · 🔒" : ""}
              {s.expiresAt ? ` · 至 ${new Date(s.expiresAt).toLocaleString()}` : " · 永久"}
            </span>
          </div>
          <div class="mhshare-li-actions">
            <button onClick={() => copyShare(s)}>复制</button>
            {s.transport === "s3" && <button onClick={() => renew(s)}>续期</button>}
            {s.url && (
              <a href={s.url} target="_blank" rel="noreferrer">
                打开
              </a>
            )}
            <button class="mhshare-danger" onClick={() => revoke(s)}>
              撤销
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

let styled = false;
function injectStyle() {
  if (styled) return;
  styled = true;
  const css = `
  .mhshare-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999}
  .mhshare-modal{background:var(--mh-bg,#fff);color:var(--mh-fg,#1f2328);width:min(480px,94vw);max-height:88vh;overflow:auto;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif}
  .mhshare-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--mh-line,#e5e7eb);position:sticky;top:0;background:inherit}
  .mhshare-head h2{font-size:16px;margin:0}
  .mhshare-x{background:none;border:0;font-size:16px;cursor:pointer;color:var(--mh-muted,#6e7781)}
  .mhshare-body{padding:14px 18px;display:flex;flex-direction:column;gap:10px}
  .mhshare-section{font-size:12px;font-weight:600;color:var(--mh-muted,#6e7781);text-transform:uppercase;letter-spacing:.04em;margin-top:6px}
  .mhshare-field{display:flex;align-items:center;gap:12px}
  .mhshare-field>span{width:48px;color:var(--mh-muted,#6e7781);flex:none}
  .mhshare-field select,.mhshare-field input{flex:1;padding:8px;border:1px solid var(--mh-line,#d0d7de);border-radius:7px;background:var(--mh-card,#f6f8fa);color:inherit}
  .mhshare-foot{display:flex;justify-content:flex-end;gap:8px;margin:4px 0 2px}
  .mhshare-foot button{padding:8px 14px;border:1px solid var(--mh-line,#d0d7de);border-radius:7px;background:var(--mh-card,#f6f8fa);color:inherit;cursor:pointer}
  .mhshare-primary{background:#0969da!important;color:#fff!important;border-color:#0969da!important}
  .mhshare-primary:disabled{opacity:.6;cursor:default}
  .mhshare-note{color:var(--mh-muted,#6e7781);font-size:13px;margin:2px 0}
  .mhshare-err{color:#cf222e;font-size:13px;margin:0}
  .mhshare-ok{color:#1a7f37;font-size:13px;margin:0}
  .mhshare-result{display:flex;gap:6px;align-items:center;padding:8px;border:1px solid var(--mh-line,#d0d7de);border-radius:7px}
  .mhshare-result code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
  .mhshare-result button,.mhshare-result a{font-size:12px;padding:4px 8px;border:1px solid var(--mh-line,#d0d7de);border-radius:5px;background:var(--mh-card,#f6f8fa);color:inherit;text-decoration:none}
  .mhshare-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
  .mhshare-list li{border:1px solid var(--mh-line,#e5e7eb);border-radius:9px;padding:9px 11px;display:flex;flex-direction:column;gap:6px}
  .mhshare-li-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .mhshare-badge{font-size:11px;background:var(--mh-card,#f6f8fa);border:1px solid var(--mh-line,#e5e7eb);border-radius:999px;padding:1px 8px}
  .mhshare-src{font-weight:600}
  .mhshare-meta{color:var(--mh-muted,#6e7781);font-size:12px}
  .mhshare-li-actions{display:flex;gap:6px;align-items:center}
  .mhshare-li-actions button,.mhshare-li-actions a{font-size:13px;padding:4px 10px;border:1px solid var(--mh-line,#d0d7de);border-radius:6px;background:var(--mh-card,#f6f8fa);color:inherit;cursor:pointer;text-decoration:none}
  .mhshare-danger{color:#cf222e!important}
  .mhshare-grants{display:flex;flex-direction:column;gap:6px}
  .mhshare-grantlist{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px}
  .mhshare-grantlist li{display:flex;align-items:center;gap:14px;padding:5px 8px;border:1px solid var(--mh-line,#e5e7eb);border-radius:7px}
  .mhshare-grantlist label{display:flex;align-items:center;gap:4px;font-size:13px;color:var(--mh-muted,#6e7781);cursor:pointer}
  .mhshare-grantdb{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mhshare-adv{align-self:flex-start;background:none;border:0;color:#0969da;font-size:12px;cursor:pointer;padding:0}
  .mhshare-access{display:flex;flex-direction:column;gap:6px}
  .mhshare-acard{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;column-gap:10px;row-gap:2px;align-items:center;padding:9px 12px;border:1px solid var(--mh-line,#d0d7de);border-radius:9px;cursor:pointer}
  .mhshare-acard.sel{border-color:#0969da;box-shadow:0 0 0 1px #0969da inset}
  .mhshare-acard input{grid-row:1 / span 2;margin:0}
  .mhshare-acard-t{font-weight:600;font-size:13.5px}
  .mhshare-acard-d{grid-column:2;color:var(--mh-muted,#6e7781);font-size:12px}
  .mhshare-hostsum{flex:1;display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--mh-line,#d0d7de);border-radius:7px;background:var(--mh-card,#f6f8fa);font-size:13px}
  .mhshare-hostsum span{flex:1}
  .mhshare-hostsum button{background:none;border:0;color:#0969da;font-size:12px;cursor:pointer;padding:0;flex:none}
  .mhshare-badge-pub{color:#0969da;border-color:transparent;background:rgba(9,105,218,.12)}
  .mhshare-guide{border:1px solid var(--mh-line,#d0d7de);border-left:3px solid #bf8700;border-radius:7px;padding:8px 11px;display:flex;flex-direction:column;gap:6px}
  .mhshare-guide p{margin:0;font-size:13px;color:var(--mh-fg,#1f2328)}
  .mhshare-guide-actions{display:flex;gap:8px;align-items:center}
  .mhshare-guide-actions button{font-size:12px;padding:4px 10px;border:1px solid var(--mh-line,#d0d7de);border-radius:6px;background:var(--mh-card,#f6f8fa);color:inherit;cursor:pointer}
  .mhshare-guide-link{border:0!important;background:none!important;color:#0969da!important;padding:4px 0!important}
  @media (prefers-color-scheme: dark){.mhshare-modal{--mh-bg:#161b22;--mh-fg:#e6edf3;--mh-line:#30363d;--mh-muted:#8b949e;--mh-card:#0d1117}}
  `;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}
