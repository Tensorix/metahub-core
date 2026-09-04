/** @jsxImportSource preact */
// Publish & share dialog. For a SITE the layout is two blocks:
//   ① 当前访问渠道 — every existing channel (public address / capability links /
//     legacy+bucket shares) as one uniform row with targeted actions;
//   ② 新增访问方式 — exactly two actions, 创建私密链接 / 发布公开网页, each
//     expanding its own form (share-modal-forms.tsx).
// "仅自己" is not a creation mode: it is the 停止公开访问 action on the public
// row. Nothing here ever rewrites the user's in-progress choices on refresh.
// For docs/databases the classic single-form flow remains (ObjectShareModal).
// Mounted imperatively (openShareModal) so entry points are a one-liner.

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  api,
  type ShareTargetOpt,
  type ShareListItem,
  type CreateShareBody,
  type GrantOp,
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
  type SiteChannel,
} from "./site-status.ts";
import { confirmDialog } from "./ui.tsx";
import {
  channelRowView,
  legacyShareRowView,
  grantSetToDraft,
  EXPIRY,
  expiryIndexFor,
  type ChannelRowAction,
  type ChannelRowView,
  type GrantDraft,
} from "./share-modal-model.ts";
import { LinkShareForm, PublicPublishForm } from "./share-modal-forms.tsx";

// Re-exports kept stable for existing consumers/tests.
export { draftToGrantSet, grantSetToDraft, type GrantDraft } from "./share-modal-model.ts";

export interface ShareTarget {
  kind: "doc" | "database" | "site";
  ref: string; // the target's id (used as target_id)
  title?: string;
}

/** The share dialog target for a list row (an expired device/Edge link can
 *  only be re-created, so the list hands the row back to the dialog). Null for
 *  a kind the dialog doesn't know. */
export function shareTargetOf(s: ShareListItem): ShareTarget | null {
  if (s.kind !== "doc" && s.kind !== "database" && s.kind !== "site") return null;
  return { kind: s.kind, ref: s.target_id, title: s.title };
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

/** Copy / renew / revoke handlers shared by the modal's rows and the global
 *  ShareView. Broadcasts SHARES_CHANGED + reloads after a mutation.
 *  Copying/renewing an s3 share ONLY re-signs the link — the snapshot content
 *  is untouched; `refreshExport` is the explicit re-export action. */
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
      const r = await api.renewShare(s.slug); // s3 link isn't stored — re-sign only
      copy(r.url);
      onFlash(
        s.contentUpdatedAt
          ? `已重新生成访问链接并复制（内容为 ${new Date(s.contentUpdatedAt).toLocaleString()} 的快照）`
          : "已重新生成访问链接并复制（内容不变）",
      );
      notifySharesChanged();
      reload();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const revoke = async (s: ShareListItem) => {
    const ok = await confirmDialog({
      title: "撤销这个分享？",
      message: "链接立即失效，接收者将无法再打开。",
      confirmLabel: "撤销",
      danger: true,
      aboveMenus: true,
    });
    if (!ok) return;
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
      onFlash("已重新生成访问链接，新链接已复制（内容不变）");
      notifySharesChanged();
      reload();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const refreshExport = async (s: ShareListItem) => {
    const ok = await confirmDialog({
      title: "更新快照内容并续期？",
      message: "将用当前最新数据覆盖这份快照，接收者会看到更新后的版本；同时生成新的访问链接。",
      confirmLabel: "更新内容并续期",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.renewShare(s.slug, { refreshContent: true });
      copy(r.url);
      onFlash("已更新快照内容并复制新链接");
      notifySharesChanged();
      reload();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return { copyShare, revoke, renew, refreshExport };
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

/** The ordered share targets as unified Scopes (current server default, then
 *  peer servers, then attached buckets). Seeded synchronously so the picker has
 *  a value before the async load; refreshed when a bucket is attached/detached
 *  on this device (onReplicaStatus). */
function useShareTargets(): [Scope[], () => void] {
  const [targets, setTargets] = useState<Scope[]>(() => buildShareTargets([], [], location.origin));
  const load = () =>
    Promise.all([api.listShareServers().catch(() => []), api.listShareBuckets().catch(() => [])]).then(
      ([servers, buckets]: [ShareTargetOpt[], ShareTargetOpt[]]) =>
        setTargets(buildShareTargets(servers, buckets, location.origin)),
    );
  useEffect(() => {
    load();
    const off = onReplicaStatus(() => load());
    return () => off();
  }, []);
  return [targets, load];
}

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => undefined);
}

function ShareModal({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  return target.kind === "site" ? (
    <SitePublishModal target={target} onClose={onClose} />
  ) : (
    <ObjectShareModal target={target} onClose={onClose} />
  );
}

// ── site: 当前访问渠道 + 新增访问方式 ─────────────────────────────────────────

const ACTION_LABEL: Record<ChannelRowAction, string> = {
  copy: "复制",
  open: "打开",
  revoke: "撤销链接",
  stopPublic: "停止公开访问",
  recreate: "重新创建链接",
  copyShare: "复制",
  renewLink: "延长有效期",
  refreshExport: "更新内容并续期",
  revokeShare: "撤销链接",
};
const DANGER_ACTIONS: ChannelRowAction[] = ["revoke", "stopPublic", "revokeShare", "refreshExport"];

/** One uniform row for every access channel (public / synced link / legacy). */
function ChannelRow({
  view,
  on,
}: {
  view: ChannelRowView;
  on: Partial<Record<ChannelRowAction, () => void>>;
}) {
  return (
    <li>
      <div class="mhshare-li-main">
        <span class={"mhshare-badge" + (view.badgeTone === "pub" ? " mhshare-badge-pub" : "")}>
          {view.badge}
        </span>
        <span class="mhshare-src">{view.title}</span>
        <span class="mhshare-meta">{view.metaLine}</span>
      </div>
      {view.warnLine && <div class="mhshare-warn">{view.warnLine}</div>}
      <div class="mhshare-li-actions">
        {/* An action with no handler in this host is not rendered: a visible
            button that does nothing is worse than an absent one. */}
        {view.actions
          .filter((a) => (a === "open" && view.url) || on[a])
          .map((a) =>
          a === "open" && view.url ? (
            <a key={a} href={view.url} target="_blank" rel="noreferrer">
              打开
            </a>
          ) : (
            <button
              key={a}
              class={DANGER_ACTIONS.includes(a) ? "mhshare-danger" : ""}
              onClick={on[a]}
            >
              {ACTION_LABEL[a]}
            </button>
          ),
        )}
      </div>
    </li>
  );
}

function SitePublishModal({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const [targets, reloadTargets] = useShareTargets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [shares, setShares] = useState<ShareListItem[]>([]);
  const [dbs, setDbs] = useState<{ id: string; name: string }[]>([]);
  const [site, setSite] = useState<Site | null>(null);
  const [siteHosting, setSiteHosting] = useState<SiteHostingInfo | null>(null);
  const [edge, setEdge] = useState<EdgeStatus | null>(null);
  // Anonymous-public grants start from the site's current synced policy; a
  // failed load keeps a retry path (never a dead end).
  const [publicGrantDraft, setPublicGrantDraft] = useState<GrantDraft>(() => new Map());
  const [publicGrantsLoaded, setPublicGrantsLoaded] = useState(false);
  const [grantsError, setGrantsError] = useState("");
  // Which "add access" form is expanded. NOTHING refresh-driven ever writes
  // this — the applySiteHosting→setAccess flip-under-the-user bug class.
  const [expandedForm, setExpandedForm] = useState<"link" | "public" | null>(null);
  const [recreateInitial, setRecreateInitial] = useState<
    { permission?: "view" | "edit"; expiresAt?: number | null } | undefined
  >(undefined);

  const refreshShares = () =>
    api.listShares({ target: target.ref }).then(setShares).catch(() => undefined);
  const refreshSiteState = () => {
    api
      .listSites()
      .then((list) => setSite(list.find((s) => s.id === target.ref) ?? null))
      .catch(() => undefined);
    api.getSiteHosting().then(setSiteHosting).catch(() => setSiteHosting(null));
  };
  const loadPublicGrants = () => {
    setGrantsError("");
    api
      .getSiteGrants(target.ref)
      .then(({ grants }) => {
        setPublicGrantDraft(grantSetToDraft(grants));
        setPublicGrantsLoaded(true);
      })
      .catch((e) => {
        setGrantsError(`无法读取现有公开权限：${(e as Error).message}`);
        setPublicGrantsLoaded(false);
      });
  };

  useEffect(() => {
    refreshShares();
    refreshSiteState();
    loadPublicGrants();
    api.listDatabases().then((list) => setDbs(list.map((d) => ({ id: d.id, name: d.name })))).catch(() => undefined);
    api.getEdgeStatus().then(setEdge).catch(() => setEdge(null));
  }, []);

  const toggleGrant = (dbId: string, op: GrantOp) => {
    setPublicGrantDraft((cur) => {
      const next = new Map(cur);
      const ops = new Set(next.get(dbId) ?? []);
      if (ops.has(op)) ops.delete(op);
      else ops.add(op);
      next.set(dbId, ops);
      return next;
    });
  };

  async function requestPrivateAccess(): Promise<boolean> {
    if (isNoOrigin()) {
      await api.updateSite(target.ref, { visibility: "private" });
      const latest = await api.getSiteHosting().catch(() => null);
      if (latest) setSiteHosting(latest);
      return !!latest?.channels.some(
        (channel) =>
          channel.siteId === target.ref &&
          channel.audience === "public" &&
          channel.desiredState === "revoked" &&
          (channel.status === "waiting_controller" || channel.status === "cleanup_pending"),
      );
    }
    const result = await api.publishSite({ siteId: target.ref, access: "private" });
    return result.status === "cleanup_pending";
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
      const pending = await requestPrivateAccess();
      setFlash(pending ? "已提交停止公开，等待托管设备收到同步" : "已停止公开访问");
      notifySharesChanged();
      refreshSiteState();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revokeChannel = async (channel: SiteChannel) => {
    if (!channel.id) return stopPublic();
    const ok = await confirmDialog({
      title: channel.audience === "anyone" ? "停止这个公开渠道？" : "撤销这个链接？",
      message:
        channel.hosting === "room"
          ? "撤销意图会同步到控制设备。若控制设备离线，Edge Room 会显示“等待控制设备”，上线后自动销毁。"
          : "撤销意图会同步到托管设备；该设备收到后将停止提供这个渠道。",
      confirmLabel: "撤销",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.revokeSiteChannel(channel.id);
      setFlash(
        result.status === "waiting_controller" || result.status === "cleanup_pending"
          ? "撤销已请求，等待控制设备完成清理"
          : "渠道已撤销",
      );
      notifySharesChanged();
      refreshShares();
      refreshSiteState();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const gotoSettings = (sec: string) => {
    onClose();
    location.hash = `#/settings?sec=${sec}`;
  };
  const afterCreate = (msg: string, url?: string) => {
    if (url) {
      copy(url);
      setResultUrl(url);
    }
    setError("");
    setFlash(msg);
    setExpandedForm(null);
    setRecreateInitial(undefined);
    notifySharesChanged();
    refreshShares();
    refreshSiteState();
  };

  // Derived channels: public rows + synced link rows + remaining legacy shares.
  const derivedChannels: SiteChannel[] = site
    ? siteChannels(siteChannelInput(site, shares, siteHosting))
    : [];
  const publicChannels = derivedChannels.filter((c) => c.audience === "anyone");
  const syncedLinkChannels = derivedChannels.filter((c) => c.audience === "link" && !!c.id);
  const syncedLinkSlugs = new Set(syncedLinkChannels.map((c) => c.slug).filter(Boolean));
  const legacyShares = shares.filter((s) => !syncedLinkSlugs.has(s.slug));
  const legacy = useShareActions(refreshShares, setFlash, setError);
  const rowCount = publicChannels.length + syncedLinkChannels.length + legacyShares.length;

  const recreateFrom = (c: { permission?: string; expiresAt?: number | null }) => {
    setRecreateInitial({
      permission: c.permission === "edit" ? "edit" : "view",
      expiresAt: c.expiresAt,
    });
    setExpandedForm("link");
  };

  return (
    <div class="mhshare-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="mhshare-modal">
        <div class="mhshare-head">
          <h2>发布与分享{target.title ? `：${target.title}` : ""}</h2>
          <button class="mhshare-x" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div class="mhshare-body">
          {error && <p class="mhshare-err">{error}</p>}
          {flash && <p class="mhshare-ok">{flash}</p>}
          {resultUrl && (
            <div class="mhshare-result">
              <code>{resultUrl}</code>
              <button onClick={() => copy(resultUrl)}>复制</button>
              <a href={resultUrl} target="_blank" rel="noreferrer">打开</a>
            </div>
          )}

          <div class="mhshare-section">当前访问渠道（{rowCount}）</div>
          {rowCount === 0 && <p class="mhshare-note">还没有任何访问渠道 — 在下方创建。</p>}
          <ul class="mhshare-list">
            {publicChannels.map((c) => (
              <ChannelRow
                key={c.id ?? c.url ?? "unverified"}
                view={channelRowView(c, { edge })}
                on={{
                  copy: () => {
                    if (c.url) {
                      copy(c.url);
                      setFlash("公开地址已复制");
                    }
                  },
                  stopPublic: () => revokeChannel(c),
                }}
              />
            ))}
            {syncedLinkChannels.map((c) => (
              <ChannelRow
                key={c.id}
                view={channelRowView(c, { edge })}
                on={{
                  copy: () => {
                    if (c.url) {
                      copy(c.url);
                      setFlash("链接已复制");
                    }
                  },
                  revoke: () => revokeChannel(c),
                  recreate: () => recreateFrom(c),
                }}
              />
            ))}
            {legacyShares.map((s) => (
              <ChannelRow
                key={s.slug}
                view={legacyShareRowView(s)}
                on={{
                  copyShare: () => legacy.copyShare(s),
                  renewLink: () => legacy.renew(s),
                  refreshExport: () => legacy.refreshExport(s),
                  revokeShare: () => legacy.revoke(s),
                  recreate: () => recreateFrom(s),
                }}
              />
            ))}
          </ul>

          <div class="mhshare-section">新增访问方式</div>
          <div class="mhshare-addrow">
            <button
              class={"mhshare-addbtn" + (expandedForm === "link" ? " sel" : "")}
              onClick={() => {
                setRecreateInitial(undefined);
                setExpandedForm(expandedForm === "link" ? null : "link");
              }}
            >
              <span class="mhshare-acard-t">创建私密链接</span>
              <span class="mhshare-acard-d">链接无法被猜到；可加口令和有效期。</span>
            </button>
            <button
              class={"mhshare-addbtn" + (expandedForm === "public" ? " sel" : "")}
              onClick={() => setExpandedForm(expandedForm === "public" ? null : "public")}
            >
              <span class="mhshare-acard-t">发布公开网页</span>
              <span class="mhshare-acard-d">任何人无需登录即可访问公开地址。</span>
            </button>
          </div>
          {expandedForm === "link" && (
            <LinkShareForm
              target={target}
              targets={targets}
              edge={edge}
              siteHosting={siteHosting}
              dbs={dbs}
              initial={recreateInitial}
              onDone={afterCreate}
              onError={setError}
              onRefreshTargets={reloadTargets}
              gotoSettings={gotoSettings}
            />
          )}
          {expandedForm === "public" && (
            <PublicPublishForm
              target={target}
              targets={targets}
              edge={edge}
              siteHosting={siteHosting}
              dbs={dbs}
              publicGrantDraft={publicGrantDraft}
              onToggleGrant={toggleGrant}
              publicGrantsLoaded={publicGrantsLoaded}
              grantsError={grantsError}
              onRetryGrants={loadPublicGrants}
              onDone={afterCreate}
              onPending={(msg) => afterCreate(msg)}
              onError={setError}
              onRefreshState={() => {
                notifySharesChanged();
                refreshShares();
                refreshSiteState();
              }}
              onRefreshTargets={reloadTargets}
              gotoSettings={gotoSettings}
            />
          )}

          <div class="mhshare-foot">
            <button onClick={onClose} disabled={busy}>关闭</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── docs / databases: the classic single-form flow ────────────────────────────

function ObjectShareModal({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const [targets] = useShareTargets();
  const [selId, setSelId] = useState("server");
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [password, setPassword] = useState("");
  const [expiryIdx, setExpiryIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shares, setShares] = useState<ShareListItem[]>([]);
  const [flash, setFlash] = useState("");
  const [resultUrl, setResultUrl] = useState("");

  const refreshShares = () =>
    api.listShares({ target: target.ref }).then(setShares).catch(() => undefined);
  useEffect(() => {
    refreshShares();
  }, []);

  // "重新创建链接" on an expired row: pre-fill the form above it. The password
  // is deliberately NOT carried over (it isn't recoverable, and silently
  // dropping it would publish an unprotected link).
  const recreateFrom = (s: ShareListItem) => {
    setPermission(s.permission === "edit" ? "edit" : "view");
    setPassword("");
    setExpiryIdx(expiryIndexFor(s.expiresAt, Date.now()));
    setError("");
    setFlash(
      s.hasPassword
        ? "已按过期链接预填上方表单；原口令无法恢复，请重新设置。"
        : "已按过期链接预填上方表单。",
    );
  };

  const sel = targets.find((t) => t.id === selId) ?? targets[0];
  const s3 = sel?.kind === "bucket";
  useEffect(() => {
    if (s3 && permission === "edit") setPermission("view");
  }, [s3]);
  const expiryOpts = s3 ? EXPIRY.filter((e) => e.ms == null || e.ms <= 604_800_000) : EXPIRY;
  const eIdx = Math.min(expiryIdx, expiryOpts.length - 1);

  async function create() {
    setBusy(true);
    setError("");
    setResultUrl("");
    try {
      const body: CreateShareBody = {
        kind: target.kind,
        ref: target.ref,
        transport: s3 ? "s3" : "server",
        hosting: "server",
        permission,
        password: password || null,
        expiresMs: expiryOpts[eIdx]?.ms ?? null,
        server: s3 ? null : sel ? shareTargetUrl(sel, location.origin) : null,
        bucketUrl: s3 && sel ? shareTargetUrl(sel, location.origin) : null,
        grants: null,
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
          <h2>分享{target.title ? `：${target.title}` : ""}</h2>
          <button class="mhshare-x" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div class="mhshare-body">
          <div class="mhshare-section">新建分享</div>
          <label class="mhshare-field">
            <span>托管位置</span>
            <select value={sel?.id} onChange={(e) => setSelId((e.currentTarget as HTMLSelectElement).value)}>
              {targets.map((t) => (
                <option value={t.id}>{t.label} — {t.subtitle}</option>
              ))}
            </select>
          </label>
          <label class="mhshare-field">
            <span>权限</span>
            <select value={permission} disabled={s3} onChange={(e) => setPermission((e.currentTarget as HTMLSelectElement).value as "view" | "edit")}>
              <option value="view">只读</option>
              <option value="edit">可编辑{s3 ? "（仅服务器）" : ""}</option>
            </select>
          </label>
          <label class="mhshare-field">
            <span>口令</span>
            <input type="password" placeholder="可选" value={password} onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="mhshare-field">
            <span>有效期</span>
            <select value={String(eIdx)} onChange={(e) => setExpiryIdx(Number((e.currentTarget as HTMLSelectElement).value))}>
              {expiryOpts.map((o, i) => (
                <option value={String(i)}>{o.label}</option>
              ))}
            </select>
          </label>
          {s3 && (
            <p class="mhshare-note">
              存储桶分享是快照链接：内容是导出时的版本，之后不会随数据变化；「更新内容并续期」才会覆盖快照。
            </p>
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
          <div class="mhshare-foot">
            <button onClick={onClose}>关闭</button>
            <button class="mhshare-primary" disabled={busy} onClick={create}>
              {busy ? "创建中…" : "创建并复制链接"}
            </button>
          </div>

          <div class="mhshare-section">已有分享（{shares.length}）</div>
          <ShareRows
            shares={shares}
            reload={refreshShares}
            onFlash={setFlash}
            onError={setError}
            onRecreate={recreateFrom}
            empty="还没有分享这个对象。"
          />
        </div>
      </div>
    </div>
  );
}

/** Reusable list of shares with copy / renew / revoke / open actions (the
 *  non-site modal, and any external manager view). */
function ShareRows({
  shares,
  reload,
  onFlash,
  onError,
  onRecreate,
  empty,
}: {
  shares: ShareListItem[];
  reload: () => void;
  onFlash: (s: string) => void;
  onError: (s: string) => void;
  /** Pre-fill the host's create form from an expired row. Hosts without a form
   *  omit it and ChannelRow then hides the action instead of showing a dead one. */
  onRecreate?: (s: ShareListItem) => void;
  empty: string;
}) {
  const legacy = useShareActions(reload, onFlash, onError);
  if (shares.length === 0) return <p class="mhshare-note">{empty}</p>;
  return (
    <ul class="mhshare-list">
      {shares.map((s) => (
        <ChannelRow
          key={s.slug}
          view={legacyShareRowView(s)}
          on={{
            copyShare: () => legacy.copyShare(s),
            renewLink: () => legacy.renew(s),
            refreshExport: () => legacy.refreshExport(s),
            revokeShare: () => legacy.revoke(s),
            ...(onRecreate ? { recreate: () => onRecreate(s) } : {}),
          }}
        />
      ))}
    </ul>
  );
}

let styled = false;
function injectStyle() {
  if (styled) return;
  styled = true;
  const css = `
  .mhshare-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:90}
  .mhshare-modal{background:var(--mh-bg,#fff);color:var(--mh-fg,#1f2328);width:min(480px,94vw);max-height:88vh;overflow:auto;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif}
  .mhshare-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--mh-line,#e5e7eb);position:sticky;top:0;background:inherit}
  .mhshare-head h2{font-size:16px;margin:0}
  .mhshare-x{background:none;border:0;font-size:16px;cursor:pointer;color:var(--mh-muted,#6e7781)}
  .mhshare-body{padding:14px 18px;display:flex;flex-direction:column;gap:10px}
  .mhshare-section{font-size:12px;font-weight:600;color:var(--mh-muted,#6e7781);text-transform:uppercase;letter-spacing:.04em;margin-top:6px}
  .mhshare-field{display:flex;align-items:center;gap:12px}
  .mhshare-field>span{width:64px;color:var(--mh-muted,#6e7781);flex:none}
  .mhshare-field select,.mhshare-field input{flex:1;padding:8px;border:1px solid var(--mh-line,#d0d7de);border-radius:7px;background:var(--mh-card,#f6f8fa);color:inherit;min-width:0}
  .mhshare-foot{display:flex;justify-content:flex-end;gap:8px;margin:4px 0 2px}
  .mhshare-foot button{padding:8px 14px;border:1px solid var(--mh-line,#d0d7de);border-radius:7px;background:var(--mh-card,#f6f8fa);color:inherit;cursor:pointer}
  .mhshare-primary{background:#0969da!important;color:#fff!important;border-color:#0969da!important}
  .mhshare-primary:disabled{opacity:.6;cursor:default}
  .mhshare-note{color:var(--mh-muted,#6e7781);font-size:13px;margin:2px 0}
  .mhshare-err{color:#cf222e;font-size:13px;margin:0}
  .mhshare-ok{color:#1a7f37;font-size:13px;margin:0}
  .mhshare-warn{color:#bf8700;font-size:12px}
  .mhshare-result{display:flex;gap:6px;align-items:center;padding:8px;border:1px solid var(--mh-line,#d0d7de);border-radius:7px}
  .mhshare-result code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
  .mhshare-result button,.mhshare-result a{font-size:12px;padding:4px 8px;border:1px solid var(--mh-line,#d0d7de);border-radius:5px;background:var(--mh-card,#f6f8fa);color:inherit;text-decoration:none}
  .mhshare-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
  .mhshare-list li{border:1px solid var(--mh-line,#e5e7eb);border-radius:9px;padding:9px 11px;display:flex;flex-direction:column;gap:6px}
  .mhshare-li-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .mhshare-badge{font-size:11px;background:var(--mh-card,#f6f8fa);border:1px solid var(--mh-line,#e5e7eb);border-radius:999px;padding:1px 8px}
  .mhshare-src{font-weight:600;overflow-wrap:anywhere}
  .mhshare-meta{color:var(--mh-muted,#6e7781);font-size:12px}
  .mhshare-li-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .mhshare-li-actions button,.mhshare-li-actions a{font-size:13px;padding:4px 10px;border:1px solid var(--mh-line,#d0d7de);border-radius:6px;background:var(--mh-card,#f6f8fa);color:inherit;cursor:pointer;text-decoration:none}
  .mhshare-danger{color:#cf222e!important}
  .mhshare-form{display:flex;flex-direction:column;gap:10px;border:1px solid var(--mh-line,#e5e7eb);border-radius:9px;padding:12px}
  .mhshare-addrow{display:flex;gap:8px}
  .mhshare-addbtn{flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:9px 12px;border:1px solid var(--mh-line,#d0d7de);border-radius:9px;background:none;color:inherit;cursor:pointer;text-align:left}
  .mhshare-addbtn.sel{border-color:#0969da;box-shadow:0 0 0 1px #0969da inset}
  .mhshare-grants{display:flex;flex-direction:column;gap:6px}
  .mhshare-grantlist{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px}
  .mhshare-grantlist li{display:flex;align-items:center;gap:14px;padding:5px 8px;border:1px solid var(--mh-line,#e5e7eb);border-radius:7px}
  .mhshare-grantlist label{display:flex;align-items:center;gap:4px;font-size:13px;color:var(--mh-muted,#6e7781);cursor:pointer}
  .mhshare-grantdb{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mhshare-adv{align-self:flex-start;background:none;border:0;color:#0969da;font-size:12px;cursor:pointer;padding:0}
  .mhshare-acard-t{font-weight:600;font-size:13.5px}
  .mhshare-acard-d{color:var(--mh-muted,#6e7781);font-size:12px}
  .mhshare-hostsum{flex:1;display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--mh-line,#d0d7de);border-radius:7px;background:var(--mh-card,#f6f8fa);font-size:13px}
  .mhshare-hostsum span{flex:1}
  .mhshare-hostsum button{background:none;border:0;color:#0969da;font-size:12px;cursor:pointer;padding:0;flex:none}
  .mhshare-badge-pub{color:#0969da;border-color:transparent;background:rgba(9,105,218,.12)}
  .mhshare-guide{border:1px solid var(--mh-line,#d0d7de);border-left:3px solid #bf8700;border-radius:7px;padding:8px 11px;display:flex;flex-direction:column;gap:6px}
  .mhshare-guide p{margin:0;font-size:13px;color:var(--mh-fg,#1f2328)}
  .mhshare-guide-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .mhshare-guide-actions button{font-size:12px;padding:4px 10px;border:1px solid var(--mh-line,#d0d7de);border-radius:6px;background:var(--mh-card,#f6f8fa);color:inherit;cursor:pointer}
  .mhshare-guide-link{border:0!important;background:none!important;color:#0969da!important;padding:4px 0!important}
  @media (prefers-color-scheme: dark){.mhshare-modal{--mh-bg:#161b22;--mh-fg:#e6edf3;--mh-line:#30363d;--mh-muted:#8b949e;--mh-card:#0d1117}}
  `;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}
