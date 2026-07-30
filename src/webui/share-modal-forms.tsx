/** @jsxImportSource preact */
// The two "add access" forms of the publish dialog: create a private
// capability link / publish the public web page. Each owns its local field
// state and submits through the parent's callbacks; the derivation logic
// (hosting plan, row views) lives in share-modal-model.ts.

import { useState } from "preact/hooks";
import {
  api,
  type CreateShareBody,
  type EdgeStatus,
  type GrantOp,
  type SiteHostingInfo,
} from "./api.ts";
import type { Scope } from "./data/scopes.ts";
import { shareTargetUrl } from "./data/share-targets.ts";
import { isNoOrigin } from "./data/replica.ts";
import { confirmDialog } from "./ui.tsx";
import {
  DEVICE_OPTION_SUFFIX,
  deviceOptionState,
  draftToGrantSet,
  EXPIRY,
  hostingPlan,
  type GrantDraft,
} from "./share-modal-model.ts";
import type { ShareTarget } from "./share-modal.tsx";

/** Per-database grant checkboxes (shared by both forms). */
export function GrantsEditor({
  dbs,
  draft,
  onToggle,
}: {
  dbs: { id: string; name: string }[];
  draft: GrantDraft;
  onToggle: (dbId: string, op: GrantOp) => void;
}) {
  const [show, setShow] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const grantedCount = [...draft.values()].filter((ops) => ops.size > 0).length;
  return (
    <div class="mhshare-grants">
      <button class="mhshare-adv" type="button" onClick={() => setShow(!show)}>
        {show
          ? "收起数据授权"
          : grantedCount > 0
            ? `数据授权：已开启 ${grantedCount} 张表…`
            : "高级：数据授权（让页面读写数据）…"}
      </button>
      {show && (
        <>
          <p class="mhshare-note">
            页面内的数据接口（<code>api/…</code>）默认关闭。若这个站点需要访客读取或提交数据，在这里按表开启。
          </p>
          {dbs.length === 0 ? (
            <p class="mhshare-note">（没有可授权的数据库）</p>
          ) : (
            <ul class="mhshare-grantlist">
              {dbs.map((d) => {
                const ops = draft.get(d.id) ?? new Set<GrantOp>();
                return (
                  <li key={d.id}>
                    <span class="mhshare-grantdb">{d.name}</span>
                    <label>
                      <input type="checkbox" checked={ops.has("read")} onChange={() => onToggle(d.id, "read")} /> 读
                    </label>
                    <label>
                      <input type="checkbox" checked={ops.has("create")} onChange={() => onToggle(d.id, "create")} /> 新增
                    </label>
                    {advanced && (
                      <label>
                        <input type="checkbox" checked={ops.has("update")} onChange={() => onToggle(d.id, "update")} /> 修改
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <button class="mhshare-adv" type="button" onClick={() => setAdvanced(!advanced)}>
            {advanced ? "收起高级选项" : "高级：允许修改已有行…"}
          </button>
        </>
      )}
    </div>
  );
}

function HostingBlock({
  plan,
  access,
  onUseEdge,
  onSyncNow,
  gotoSettings,
  syncing,
}: {
  plan: ReturnType<typeof hostingPlan>;
  access: "link" | "public";
  onUseEdge: () => void;
  onSyncNow: () => void;
  gotoSettings: (sec: string) => void;
  syncing: boolean;
}) {
  if (!plan.blocked) return null;
  return (
    <div class="mhshare-guide">
      <p>{plan.blocked}</p>
      <div class="mhshare-guide-actions">
        {plan.wantsSyncNow && (
          <button type="button" onClick={onSyncNow} disabled={syncing}>
            {syncing ? "同步中…" : "立即同步"}
          </button>
        )}
        {access === "link" && plan.deviceBlocked && plan.edgeUsable && (
          <button type="button" onClick={onUseEdge}>改用 Edge 托管</button>
        )}
        <button type="button" onClick={() => gotoSettings("hosting")}>
          前往设置 → 站点与发布
        </button>
        {plan.deviceBlocked && isNoOrigin() && (
          <button type="button" class="mhshare-guide-link" onClick={() => gotoSettings("backup")}>
            了解此设备的同步方式
          </button>
        )}
      </div>
    </div>
  );
}

function HostingPicker({
  plan,
  access,
  hostingAuto,
  setHostingAuto,
  hosting,
  setHosting,
  selId,
  setSelId,
  edge,
}: {
  plan: ReturnType<typeof hostingPlan>;
  access: "link" | "public";
  hostingAuto: boolean;
  setHostingAuto: (v: boolean) => void;
  hosting: "device" | "edge";
  setHosting: (v: "device" | "edge") => void;
  selId: string;
  setSelId: (v: string) => void;
  edge: EdgeStatus | null;
}) {
  return (
    <>
      {hostingAuto ? (
        <div class="mhshare-field">
          <span>托管位置</span>
          <div class="mhshare-hostsum">
            <span>
              {plan.effHosting === "edge"
                ? "Edge 托管 — 设备离线仍可访问"
                : `设备在线托管 — ${plan.effSel?.label ?? "本机"}，需保持在线`}
            </span>
            <button
              type="button"
              onClick={() => {
                setHosting(plan.effHosting);
                if (plan.effSel) setSelId(plan.effSel.id);
                setHostingAuto(false);
              }}
            >
              更改
            </button>
          </div>
        </div>
      ) : (
        <>
          <label class="mhshare-field">
            <span>托管位置</span>
            <select
              value={plan.effHosting}
              onChange={(e) => setHosting((e.currentTarget as HTMLSelectElement).value as "device" | "edge")}
            >
              <option value="device" disabled={isNoOrigin() || plan.allDeviceTargets.length === 0}>
                设备在线托管{isNoOrigin() ? "（此设备无法托管）" : ""}
              </option>
              <option
                value="edge"
                disabled={access === "public" || !plan.edgeUsable}
              >
                Edge 托管 · 设备离线仍可访问
                {access === "public"
                  ? "（公开网页暂不支持）"
                  : edge?.configured
                    ? edge.capabilities?.includes("room")
                      ? ""
                      : "（当前端点仅支持 inbox）"
                    : "（请先配置）"}
              </option>
            </select>
          </label>
          {plan.effHosting === "device" && (
            <label class="mhshare-field">
              <span>设备</span>
              <select value={selId} onChange={(e) => setSelId((e.currentTarget as HTMLSelectElement).value)}>
                {plan.allDeviceTargets.map((t) => {
                  const state = deviceOptionState(t);
                  return (
                    <option value={t.id} disabled={state !== "ok"}>
                      {t.label} — {t.subtitle}
                      {DEVICE_OPTION_SUFFIX[state]}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
        </>
      )}
    </>
  );
}

/** Shared "立即同步 the first waiting device" action. */
function useSyncNow(plan: () => ReturnType<typeof hostingPlan>, onDone: () => void, onError: (s: string) => void) {
  const [syncing, setSyncing] = useState(false);
  const syncNow = async () => {
    const waiting = plan().allDeviceTargets.find((t) => deviceOptionState(t) === "never_synced" || deviceOptionState(t) === "error");
    const url = waiting ? shareTargetUrl(waiting, location.origin) : null;
    if (!url) return;
    setSyncing(true);
    try {
      const r = await api.syncPeer(url);
      if (!r.ok) throw new Error(r.error ?? "同步失败");
      onDone();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };
  return { syncNow, syncing };
}

export function LinkShareForm({
  target,
  targets,
  edge,
  siteHosting,
  dbs,
  initial,
  onDone,
  onError,
  onRefreshTargets,
  gotoSettings,
}: {
  target: ShareTarget;
  targets: Scope[];
  edge: EdgeStatus | null;
  siteHosting: SiteHostingInfo | null;
  dbs: { id: string; name: string }[];
  /** Pre-fill for "重新创建链接" from an expired row (password must be re-set). */
  initial?: { permission?: "view" | "edit"; expiresAt?: number | null };
  onDone: (flash: string, url: string) => void;
  onError: (msg: string) => void;
  onRefreshTargets: () => void;
  gotoSettings: (sec: string) => void;
}) {
  const [permission, setPermission] = useState<"view" | "edit">(initial?.permission ?? "view");
  const [password, setPassword] = useState("");
  const [expiryIdx, setExpiryIdx] = useState(() => {
    if (initial?.expiresAt == null) return 0;
    const remaining = initial.expiresAt - Date.now();
    // Closest bucket that covers what the expired link had (best-effort).
    const idx = EXPIRY.findIndex((e) => e.ms != null && e.ms >= remaining);
    return idx === -1 ? EXPIRY.length - 1 : Math.max(1, idx);
  });
  const [hostingAuto, setHostingAuto] = useState(true);
  const [hosting, setHosting] = useState<"device" | "edge">(isNoOrigin() ? "edge" : "device");
  const [selId, setSelId] = useState("server");
  const [grantDraft, setGrantDraft] = useState<GrantDraft>(() => new Map());
  const [busy, setBusy] = useState(false);

  const plan = hostingPlan({
    access: "link",
    hostingAuto,
    hosting,
    selId,
    targets,
    noOrigin: isNoOrigin(),
    edge,
    serverEntryOk: !!siteHosting?.publicBaseUrl,
  });
  const { syncNow, syncing } = useSyncNow(() => plan, onRefreshTargets, onError);

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

  const submit = async () => {
    setBusy(true);
    try {
      const edgeHosting = plan.effHosting === "edge";
      if (edgeHosting && !edge?.configured)
        throw new Error("请先在“设置 → 站点与发布”连接或部署 Edge");
      if (edgeHosting && !edge?.capabilities?.includes("room"))
        throw new Error("当前 Edge 端点仅支持数据收件（inbox），不能托管站点");
      if (!edgeHosting && isNoOrigin())
        throw new Error("此设备通过同步存储桶交换数据、不常驻在线；请改为 Edge 托管的链接");
      if (!edgeHosting && plan.effSel?.id === "server" && !siteHosting?.publicBaseUrl)
        throw new Error("请先在“设置 → 站点与发布”配置当前设备的公网或局域网入口");
      const grantSet = draftToGrantSet(grantDraft);
      const server = edgeHosting
        ? null
        : plan.effSel?.id === "server"
          ? (siteHosting?.publicBaseUrl ?? null)
          : plan.effSel
            ? shareTargetUrl(plan.effSel, location.origin)
            : null;
      const body: CreateShareBody = {
        kind: target.kind,
        ref: target.ref,
        transport: "server",
        hosting: edgeHosting ? "room" : "server",
        permission,
        password: password || null,
        expiresMs: EXPIRY[expiryIdx]?.ms ?? null,
        server,
        bucketUrl: null,
        grants: grantSet ? JSON.stringify(grantSet) : null,
      };
      const r = await api.createShare(body);
      setPassword("");
      onDone(`已通过「${r.source}」创建私密链接，地址已复制`, r.url);
    } catch (e) {
      onError((e as Error).message || "创建失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="mhshare-form">
      {initial && (
        <p class="mhshare-note">从过期链接重新创建 — 口令需重新设置（旧口令无法恢复）。</p>
      )}
      <HostingPicker
        plan={plan}
        access="link"
        hostingAuto={hostingAuto}
        setHostingAuto={setHostingAuto}
        hosting={hosting}
        setHosting={setHosting}
        selId={selId}
        setSelId={setSelId}
        edge={edge}
      />
      <HostingBlock
        plan={plan}
        access="link"
        onUseEdge={() => {
          setHostingAuto(false);
          setHosting("edge");
        }}
        onSyncNow={syncNow}
        gotoSettings={gotoSettings}
        syncing={syncing}
      />
      <label class="mhshare-field">
        <span>权限</span>
        <select value={permission} onChange={(e) => setPermission((e.currentTarget as HTMLSelectElement).value as "view" | "edit")}>
          <option value="view">只读</option>
          <option value="edit">可编辑</option>
        </select>
      </label>
      <label class="mhshare-field">
        <span>口令</span>
        <input type="password" placeholder="可选" value={password} onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)} />
      </label>
      <label class="mhshare-field">
        <span>有效期</span>
        <select value={String(expiryIdx)} onChange={(e) => setExpiryIdx(Number((e.currentTarget as HTMLSelectElement).value))}>
          {EXPIRY.map((o, i) => (
            <option value={String(i)}>{o.label}</option>
          ))}
        </select>
      </label>
      <GrantsEditor dbs={dbs} draft={grantDraft} onToggle={toggleGrant} />
      <p class="mhshare-note">
        站点页面与管理界面同源运行：站点内的脚本可以以你的身份读写整个工作区。只发布你信任的代码。
      </p>
      <div class="mhshare-foot">
        <button class="mhshare-primary" disabled={busy || !!plan.blocked} onClick={submit}>
          {busy ? "创建中…" : "创建私密链接"}
        </button>
      </div>
    </div>
  );
}

export function PublicPublishForm({
  target,
  targets,
  edge,
  siteHosting,
  dbs,
  publicGrantDraft,
  onToggleGrant,
  publicGrantsLoaded,
  grantsError,
  onRetryGrants,
  onDone,
  onPending,
  onError,
  onRefreshTargets,
  gotoSettings,
}: {
  target: ShareTarget;
  targets: Scope[];
  edge: EdgeStatus | null;
  siteHosting: SiteHostingInfo | null;
  dbs: { id: string; name: string }[];
  publicGrantDraft: GrantDraft;
  onToggleGrant: (dbId: string, op: GrantOp) => void;
  publicGrantsLoaded: boolean;
  grantsError: string;
  onRetryGrants: () => void;
  onDone: (flash: string, url?: string) => void;
  onPending: (flash: string) => void;
  onError: (msg: string) => void;
  onRefreshTargets: () => void;
  gotoSettings: (sec: string) => void;
}) {
  const [hostingAuto, setHostingAuto] = useState(true);
  const [selId, setSelId] = useState("server");
  const [busy, setBusy] = useState(false);

  const plan = hostingPlan({
    access: "public",
    hostingAuto,
    hosting: "device",
    selId,
    targets,
    noOrigin: isNoOrigin(),
    edge,
    serverEntryOk: !!siteHosting?.publicBaseUrl,
  });
  const { syncNow, syncing } = useSyncNow(() => plan, onRefreshTargets, onError);

  const submit = async () => {
    setBusy(true);
    try {
      if (!publicGrantsLoaded)
        throw new Error("现有公开权限尚未加载，请先点「重新加载权限」。");
      const grantSet = draftToGrantSet(publicGrantDraft);
      const tableCount = grantSet?.tables.length ?? 0;
      const ok = await confirmDialog({
        title: "确认公开发布到设备？",
        message:
          `任何人无需登录即可通过这个地址访问。公开权限会同步，但只有选定的托管设备提供此渠道；改回私有后，浏览器或 CDN 缓存仍可能保留数分钟。数据授权：${tableCount} 个数据库。设备必须保持在线。\n\n站点页面与管理界面同源运行：站点内的脚本可以以你的身份读写整个工作区。只发布你信任的代码。`,
        confirmLabel: "确认公开发布",
        danger: true,
      });
      if (!ok) return;
      const targetBase =
        plan.effSel?.id === "server"
          ? undefined
          : plan.effSel
            ? shareTargetUrl(plan.effSel, location.origin)
            : undefined;
      const published = await api.publishSite({
        siteId: target.ref,
        access: "public",
        grants: grantSet ?? { v: 1, tables: [] },
        targetBase,
      });
      if (published.status === "rollback_pending") {
        onError(
          `发布失败，目标设备的回滚尚未确认；在确认前它可能仍可公开访问。${published.error ? ` ${published.error}` : ""}`,
        );
        return;
      }
      if (!published.url) throw new Error("发布未返回访问地址");
      if (published.status === "ready") onDone("站点已上线，地址已复制", published.url);
      else onPending("正在同步到目标设备；确认地址可访问后才会视为发布成功");
    } catch (e) {
      onError((e as Error).message || "发布失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="mhshare-form">
      {!publicGrantsLoaded && (
        <div class="mhshare-guide">
          <p>{grantsError || "现有公开权限尚未加载。"}</p>
          <div class="mhshare-guide-actions">
            <button type="button" onClick={onRetryGrants}>重新加载权限</button>
          </div>
        </div>
      )}
      <HostingPicker
        plan={plan}
        access="public"
        hostingAuto={hostingAuto}
        setHostingAuto={setHostingAuto}
        hosting="device"
        setHosting={() => undefined}
        selId={selId}
        setSelId={setSelId}
        edge={edge}
      />
      <HostingBlock
        plan={plan}
        access="public"
        onUseEdge={() => undefined}
        onSyncNow={syncNow}
        gotoSettings={gotoSettings}
        syncing={syncing}
      />
      <GrantsEditor dbs={dbs} draft={publicGrantDraft} onToggle={onToggleGrant} />
      <p class="mhshare-note">
        托管设备必须保持在线。渠道和撤销意图会随工作区同步，其他设备不会自动获得这个公开地址。
      </p>
      <div class="mhshare-foot">
        <button
          class="mhshare-primary"
          disabled={busy || !!plan.blocked || !publicGrantsLoaded}
          onClick={submit}
        >
          {busy ? "发布中…" : "发布公开网页"}
        </button>
      </div>
    </div>
  );
}
