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
  type SiteHostingInfo,
} from "./api.ts";
import { buildShareTargets, shareTargetUrl } from "./data/share-targets.ts";
import { onReplicaStatus } from "./data/replica.ts";
import type { Scope } from "./data/scopes.ts";
import { isNoOrigin } from "./data/replica.ts";

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
        .listShares()
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
      await api.revokeShare(s.slug, s.sourceUrl);
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [edge, setEdge] = useState<EdgeStatus | null>(null);
  const [siteHosting, setSiteHosting] = useState<SiteHostingInfo | null>(null);
  const [resultUrl, setResultUrl] = useState("");

  useEffect(() => {
    refreshShares();
    if (target.kind === "site")
      api.listDatabases().then((list) => setDbs(list.map((d) => ({ id: d.id, name: d.name })))).catch(() => undefined);
    if (target.kind === "site") {
      api.getEdgeStatus().then(setEdge).catch(() => setEdge(null));
      if (!isNoOrigin()) api.getSiteHosting().then(setSiteHosting).catch(() => setSiteHosting(null));
    }
  }, []);

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

  const siteKind = target.kind === "site";
  const deviceTargets = targets.filter(
    (t) => t.kind === "server" && (!isNoOrigin() || t.id !== "server"),
  );
  const sel = targets.find((t) => t.id === selId) ?? deviceTargets[0] ?? targets[0];
  const s3 = !siteKind && sel?.kind === "bucket";
  useEffect(() => {
    if (s3 && permission === "edit") setPermission("view");
  }, [s3]);
  const expiryOpts = s3 ? EXPIRY.filter((e) => e.ms == null || e.ms <= 604_800_000) : EXPIRY;
  const eIdx = Math.min(expiryIdx, expiryOpts.length - 1);

  async function create() {
    if (s3 && siteKind) {
      setError("站点不支持对象存储分享，请选服务器。");
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
        return;
      }

      if (siteKind && hosting === "device" && isNoOrigin())
        throw new Error("桶模式没有可托管站点的设备，请选择 Edge");
      if (siteKind && hosting === "edge" && !edge?.configured)
        throw new Error("请先在“设置 → 站点托管”连接或部署 Edge");
      if (
        siteKind &&
        hosting === "device" &&
        sel?.id === "server" &&
        !siteHosting?.publicBaseUrl
      )
        throw new Error("请先在“设置 → 站点托管”配置当前设备的公网或局域网入口");

      if (siteKind && access === "public" && hosting === "device") {
        const targetBase =
          sel?.id === "server"
            ? undefined
            : sel
              ? shareTargetUrl(sel, location.origin)
              : undefined;
        const published = await api.publishSite({
          siteId: target.ref,
          access: "public",
          grants: grantSet ?? { v: 1, tables: [] },
          targetBase,
        });
        if (!published.url) throw new Error("发布未返回访问地址");
        if (published.status === "ready") {
          copy(published.url);
          setResultUrl(published.url);
          setFlash("站点已上线，地址已复制");
        } else {
          setFlash("正在同步到目标设备；确认地址可访问后才会视为发布成功");
        }
        notifySharesChanged();
        return;
      }

      const edgeHosting = siteKind && hosting === "edge";
      const effectivePassword = siteKind && access === "public" ? null : password || null;
      const effectiveExpiry =
        siteKind && access === "public" ? null : expiryOpts[eIdx]?.ms ?? null;
      const server =
        edgeHosting
          ? null
          : siteKind && sel?.id === "server"
            ? siteHosting?.publicBaseUrl ?? location.origin
            : sel
              ? shareTargetUrl(sel, location.origin)
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
          <div class="mhshare-section">新建分享</div>
          {siteKind && (
            <label class="mhshare-field">
              <span>访问</span>
              <select
                value={access}
                onChange={(e) =>
                  setAccess(
                    (e.currentTarget as HTMLSelectElement).value as
                      | "private"
                      | "public"
                      | "link",
                  )
                }
              >
                <option value="private">仅自己（停止直接公开）</option>
                <option value="public">任何人</option>
                <option value="link">持链接者</option>
              </select>
            </label>
          )}
          {(!siteKind || access !== "private") && (
            <label class="mhshare-field">
              <span>托管</span>
              {siteKind ? (
                <select
                  value={hosting}
                  onChange={(e) =>
                    setHosting(
                      (e.currentTarget as HTMLSelectElement).value as "device" | "edge",
                    )
                  }
                >
                  <option value="device" disabled={isNoOrigin() || deviceTargets.length === 0}>
                    设备在线托管{isNoOrigin() ? "（桶模式不可用）" : ""}
                  </option>
                  <option value="edge" disabled={!edge?.configured}>
                    Edge 始终在线{edge?.configured ? "" : "（请先配置）"}
                  </option>
                </select>
              ) : (
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
              )}
            </label>
          )}
          {siteKind && access !== "private" && hosting === "device" && (
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
              <div class="mhshare-section">数据授权（可选）</div>
              <p class="mhshare-note">
                让这个链接里的页面按表读写数据（页面内 <code>api/…</code> 调用）。不勾选则页面数据调用不可用。
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
          {siteKind && hosting === "device" && access !== "private" && (
            <p class="mhshare-note">设备必须保持在线；公开状态会随工作区同步到其他运行托管服务的节点。</p>
          )}
          {siteKind && hosting === "edge" && access !== "private" && (
            <p class="mhshare-note">Edge 会持续提供最后一次同步的版本；桶模式关闭浏览器后暂停更新，重新打开后继续同步。</p>
          )}
          <div class="mhshare-foot">
            <button onClick={onClose}>关闭</button>
            <button class="mhshare-primary" disabled={busy} onClick={create}>
              {busy ? "发布中…" : access === "private" && siteKind ? "保存" : "发布并复制地址"}
            </button>
          </div>

          <div class="mhshare-section">已有分享（{shares.length}）</div>
          <ShareRows shares={shares} reload={refreshShares} onFlash={setFlash} onError={setError} empty="还没有分享这个对象。" />
        </div>
      </div>
    </div>
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
              {s.hosting === "room" ? "Edge" : s.transport === "s3" ? "对象存储" : "设备"}
            </span>
            <span class="mhshare-src">{s.source}</span>
            <span class="mhshare-meta">
              {s.permission === "edit" ? "可编辑" : "只读"}
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
  @media (prefers-color-scheme: dark){.mhshare-modal{--mh-bg:#161b22;--mh-fg:#e6edf3;--mh-line:#30363d;--mh-muted:#8b949e;--mh-card:#0d1117}}
  `;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}
