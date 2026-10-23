/** @jsxImportSource preact */
// Publish & share dialog. For a SITE the layout is two blocks:
//   ① 当前访问渠道 — every existing channel (public address / capability links /
//     legacy+bucket shares) as one uniform row with targeted actions;
//   ② 新增访问方式 — exactly two actions, 创建私密链接 / 发布公开网页, each
//     expanding its own form (share-modal-forms.tsx).
// "仅自己" is not a creation mode: it is the 停止公开访问 action on the public
// row. Nothing here ever rewrites the user's in-progress choices on refresh.
// Documents/databases use a focused link detail and creation flow.
// Mounted imperatively (openShareModal) so entry points are a one-liner.

import { useEffect, useState } from "preact/hooks";
import {
  api,
  type ShareTargetOpt,
  type ShareListItem,
  type GrantOp,
  type EdgeStatus,
  type Site,
  type SiteHostingInfo,
  SHARES_CHANGED,
  notifySharesChanged,
} from "./api.ts";
import { buildShareTargets } from "./data/share-targets.ts";
import { onReplicaStatus } from "./data/replica.ts";
import type { Scope } from "./data/scopes.ts";
import { isNoOrigin } from "./data/replica.ts";
import {
  siteChannelInput,
  siteChannels,
  type SiteChannel,
} from "./site-status.ts";
import { Modal, confirmDialog, openModal, closeModal } from "./ui.tsx";
import { t } from "./i18n/t.ts";
import { fmtDate } from "./i18n/fmt.ts";
import {
  channelRowView,
  legacyShareRowView,
  grantSetToDraft,
  type ChannelRowAction,
  type ChannelRowView,
  type GrantDraft,
} from "./share-modal-model.ts";
import { ObjectShareDialog } from "./object-share-dialog.tsx";
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

export { SHARES_CHANGED, notifySharesChanged };

export { useSharedTargets } from "./shared-targets.ts";

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
      onFlash(t("链接已复制"));
      return;
    }
    try {
      const r = await api.renewShare(s.slug); // s3 link isn't stored — re-sign only
      copy(r.url);
      onFlash(
        s.contentUpdatedAt
          ? t("已重新生成访问链接并复制（内容为 {when} 的快照）", { when: fmtDate(s.contentUpdatedAt, "dateTime") })
          : t("已重新生成访问链接并复制（内容不变）"),
      );
      notifySharesChanged();
      reload();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const revoke = async (s: ShareListItem) => {
    const ok = await confirmDialog({
      title: t("撤销这个分享？"),
      message: t("链接立即失效，接收者将无法再打开。"),
      confirmLabel: t("撤销"),
      danger: true,
      aboveMenus: true,
    });
    if (!ok) return;
    try {
      const result = await api.revokeShare(s.slug, s.sourceUrl);
      if (result.status === "cleanup_pending") {
        onError(s.transport === "s3"
          ? t("远端尚未确认完成撤销，管理记录已保留，请重试撤销。")
          : t("撤销已提交，但 Edge 尚未确认销毁 Room；本地保留管理记录并会继续重试。"));
        notifySharesChanged();
        reload();
        return;
      }
      onFlash(t("已撤销"));
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
      onFlash(t("已重新生成访问链接，新链接已复制（内容不变）"));
      notifySharesChanged();
      reload();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const refreshExport = async (s: ShareListItem) => {
    const ok = await confirmDialog({
      title: t("更新快照内容并续期？"),
      message: t("将用当前最新数据覆盖这份快照，接收者会看到更新后的版本；同时生成新的访问链接。"),
      confirmLabel: t("更新内容并续期"),
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.renewShare(s.slug, { refreshContent: true });
      copy(r.url);
      onFlash(t("已更新快照内容并复制新链接"));
      notifySharesChanged();
      reload();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return { copyShare, revoke, renew, refreshExport };
}

export function openShareModal(target: ShareTarget): void {
  openModal(<ShareModal target={target} onClose={closeModal} />);
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
  copy: t("复制"),
  open: t("打开"),
  revoke: t("撤销链接"),
  stopPublic: t("停止公开访问"),
  recreate: t("重新创建链接"),
  copyShare: t("复制"),
  renewLink: t("延长有效期"),
  refreshExport: t("更新内容并续期"),
  revokeShare: t("撤销链接"),
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
              {t("打开")}
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
        setGrantsError(t("无法读取现有公开权限：{msg}", { msg: (e as Error).message }));
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
      title: t("停止公开访问？"),
      message: t("任何人将无法再通过公开地址访问这个站点；已有的分享链接不受影响。浏览器或 CDN 缓存可能仍保留数分钟。"),
      confirmLabel: t("停止公开"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError("");
    try {
      const pending = await requestPrivateAccess();
      setFlash(pending ? t("已提交停止公开，等待托管设备收到同步") : t("已停止公开访问"));
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
      title: channel.audience === "anyone" ? t("停止这个公开渠道？") : t("撤销这个链接？"),
      message:
        channel.hosting === "room"
          ? t("撤销意图会同步到控制设备。若控制设备离线，Edge Room 会显示“等待控制设备”，上线后自动销毁。")
          : t("撤销意图会同步到托管设备；该设备收到后将停止提供这个渠道。"),
      confirmLabel: t("撤销"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.revokeSiteChannel(channel.id);
      setFlash(
        result.status === "waiting_controller" || result.status === "cleanup_pending"
          ? t("撤销已请求，等待控制设备完成清理")
          : t("渠道已撤销"),
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
    <Modal
      title={target.title ? t("发布与分享：{title}", { title: target.title }) : t("发布与分享")}
      width={520}
      footer={<button class="btn btn-secondary" onClick={onClose} disabled={busy}>{t("关闭")}</button>}
    >
        <div class="mhshare-body">
          {error && <p class="mhshare-err">{error}</p>}
          {flash && <p class="mhshare-ok">{flash}</p>}
          {resultUrl && (
            <div class="mhshare-result">
              <code>{resultUrl}</code>
              <button onClick={() => copy(resultUrl)}>{t("复制")}</button>
              <a href={resultUrl} target="_blank" rel="noreferrer">{t("打开")}</a>
            </div>
          )}

          <div class="mhshare-section">{t("当前访问渠道（{n}）", { n: rowCount })}</div>
          {rowCount === 0 && <p class="mhshare-note">{t("还没有任何访问渠道 — 在下方创建。")}</p>}
          <ul class="mhshare-list">
            {publicChannels.map((c) => (
              <ChannelRow
                key={c.id ?? c.url ?? "unverified"}
                view={channelRowView(c, { edge })}
                on={{
                  copy: () => {
                    if (c.url) {
                      copy(c.url);
                      setFlash(t("公开地址已复制"));
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
                      setFlash(t("链接已复制"));
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

          <div class="mhshare-section">{t("新增访问方式")}</div>
          <div class="mhshare-addrow">
            <button
              class={"mhshare-addbtn" + (expandedForm === "link" ? " sel" : "")}
              onClick={() => {
                setRecreateInitial(undefined);
                setExpandedForm(expandedForm === "link" ? null : "link");
              }}
            >
              <span class="mhshare-acard-t">{t("创建私密链接")}</span>
              <span class="mhshare-acard-d">{t("链接无法被猜到；可加口令和有效期。")}</span>
            </button>
            <button
              class={"mhshare-addbtn" + (expandedForm === "public" ? " sel" : "")}
              onClick={() => setExpandedForm(expandedForm === "public" ? null : "public")}
            >
              <span class="mhshare-acard-t">{t("发布公开网页")}</span>
              <span class="mhshare-acard-d">{t("任何人无需登录即可访问公开地址。")}</span>
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

        </div>
    </Modal>
  );
}

// Documents and databases use a task-focused link detail and creation flow.
function ObjectShareModal({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const [targets] = useShareTargets();
  return <ObjectShareDialog target={target} targets={targets} onClose={onClose} />;
}
