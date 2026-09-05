/** @jsxImportSource preact */
// Global "分享" view — a top-level pane (parallel to 站点/Sites) listing every
// share this node can see: its local server shares + each attached bucket + each
// paired peer (aggregated server-side, see share-actions listSharesAggregated).
// Per-object management still lives in the share dialog; this is the bird's-eye
// list. Design: one row = object · status · ONE primary action · overflow menu.
// Status drives the action (copy / 续期 / 重新分享 / 重试撤销); expired rows sink
// into their own group with a bulk clean-up. All derivation lives in
// shares-model.ts (tested); this file is wiring + JSX.

import { useEffect, useMemo, useState } from "preact/hooks";
import { api, type ShareListItem } from "./api.ts";
import { Icon } from "./icons.tsx";
import { toast, openMenu, MenuItem, MenuSep, MenuLabel, confirmDialog } from "./ui.tsx";
import { useShareActions, SHARES_CHANGED, notifySharesChanged, openShareModal, shareTargetOf } from "./share-modal.tsx";
import type { Navigate } from "./view.ts";
import {
  EMPTY_FILTER,
  SOURCE_KINDS,
  SOURCE_KIND_LABEL,
  STATUS_FILTERS,
  countBySource,
  countByStatus,
  displayUrl,
  filterShares,
  fmtSnapshot,
  groupShares,
  matchesStatus,
  primaryAction,
  shareStatus,
  sourceLabel,
  type PrimaryAction,
  type ShareFilter,
  type ShareStatus,
} from "./shares-model.ts";

const KIND_ICON: Record<string, string> = { doc: "file", database: "database", site: "globe" };
/** Last loaded row count — the skeleton renders that many rows next time so
 *  the swap to real data doesn't reflow (session-scoped, best-effort). */
const SKEL_ROWS_KEY = "mh_shares_n";
function rememberedRows(): number {
  try {
    const n = Number(sessionStorage.getItem(SKEL_ROWS_KEY));
    return n > 0 ? Math.min(8, Math.max(2, n)) : 3;
  } catch {
    return 3;
  }
}
function rememberRows(n: number): void {
  try {
    sessionStorage.setItem(SKEL_ROWS_KEY, String(n));
  } catch {
    /* private mode */
  }
}

/** Loading placeholder built from the REAL row markup and classes: the grid,
 *  padding, status/action slots and the mobile stacking all come from the same
 *  .shv-* rules, so the skeleton can't drift from the rows it stands in for.
 *  Only the content is swapped for sheen blocks. */
function ShareListSkeleton({ rows }: { rows: number }) {
  return (
    <ul class="shv-list skel-list" role="status" aria-live="polite" aria-busy="true" aria-label="正在加载分享列表">
      {Array.from({ length: rows }, (_, i) => (
        <li class="shv-row skel" key={i} style={`--i:${Math.min(i, 4)}`}>
          <span class="shv-ico skel-b" />
          <div class="shv-main">
            <span class="shv-title skel-b skel-t" />
            <div class="shv-sub"><span class="skel-b skel-s" /></div>
          </div>
          <span class="shv-status"><span class="shv-dot skel-b" /><span class="skel-b skel-st" /></span>
          <div class="shv-actions"><span class="skel-b skel-btn" /><span class="skel-b skel-ib" /></div>
        </li>
      ))}
    </ul>
  );
}
const OPEN_OBJECT_LABEL: Record<string, string> = { doc: "打开原文档", database: "打开原表格", site: "打开站点配置" };

export function ShareView({ onNavigate }: { onNavigate: Navigate }) {
  const [shares, setShares] = useState<ShareListItem[] | null>(null);
  // First-load failure lands on the page (retry card) rather than in a toast
  // that leaves the skeleton spinning forever; later reload failures keep the
  // last good list and toast instead.
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<ShareFilter>(EMPTY_FILTER);
  /** Rows whose primary action is in flight (button disabled, label "处理中…"). */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [clearing, setClearing] = useState(false);
  const [skelRows] = useState(rememberedRows);

  const reload = () => {
    setLoadErr(null);
    return api
      .listShares()
      .then((list) => {
        setShares(list);
        rememberRows(list.length);
      })
      .catch((e) => {
        setLoadErr(String(e.message ?? e));
        if (shares != null) toast(`加载失败：${e.message}`);
      });
  };

  useEffect(() => {
    reload();
    document.addEventListener(SHARES_CHANGED, reload);
    return () => document.removeEventListener(SHARES_CHANGED, reload);
  }, []);

  const { copyShare, revoke, renew, refreshExport } = useShareActions(reload, toast, toast);

  const now = Date.now();
  const all = shares ?? [];
  // Source + search first (counts are computed over this), status last.
  const scoped = useMemo(() => filterShares(all, filter), [all, filter.source, filter.q]);
  const counts = useMemo(() => countByStatus(scoped, now), [scoped]);
  const sourceCounts = useMemo(() => countBySource(all), [all]);
  const shown = useMemo(
    () => scoped.filter((s) => matchesStatus(shareStatus(s, now), filter.status)),
    [scoped, filter.status],
  );
  const { live, expired } = useMemo(() => groupShares(shown, now), [shown]);
  const filtered = filter.status !== "all" || filter.source !== "all" || filter.q.trim() !== "";

  const openObject = (s: ShareListItem) => {
    if (s.kind === "doc") onNavigate({ kind: "doc", id: s.target_id });
    else if (s.kind === "database") onNavigate({ kind: "db", id: s.target_id });
    else onNavigate({ kind: "sites" });
  };

  const recreate = (s: ShareListItem) => {
    const t = shareTargetOf(s);
    if (!t) return toast("这类对象无法在这里重新分享");
    openShareModal(t);
  };

  const withBusy = async (s: ShareListItem, fn: () => Promise<unknown> | void) => {
    setBusy((b) => new Set(b).add(s.slug));
    try {
      await fn();
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(s.slug);
        return n;
      });
    }
  };

  const runPrimary = (s: ShareListItem, pa: PrimaryAction) => {
    switch (pa.kind) {
      case "copy":
        return withBusy(s, () => copyShare(s));
      case "renew":
        return withBusy(s, () => renew(s));
      case "recreate":
        return recreate(s);
      case "retryRevoke":
        return withBusy(s, () => revoke(s));
    }
  };

  const openRowMenu = (e: MouseEvent, s: ShareListItem, st: ShareStatus) => {
    const s3 = s.transport === "s3";
    const openable = !!s.url && st.state !== "expired";
    openMenu(e, (close) => (
      <>
        {openable && (
          <MenuItem
            icon="externalLink"
            label="打开链接"
            onClick={() => {
              close();
              window.open(s.url, "_blank", "noreferrer");
            }}
          />
        )}
        <MenuItem
          icon={KIND_ICON[s.kind] ?? "file"}
          label={OPEN_OBJECT_LABEL[s.kind] ?? "打开原对象"}
          onClick={() => {
            close();
            openObject(s);
          }}
        />
        {s3 && st.state !== "cleanup_pending" && (
          <>
            <MenuSep />
            <MenuItem
              icon="link"
              label="续期（仅链接）"
              sublabel="内容不变，重新生成访问链接"
              onClick={() => {
                close();
                void withBusy(s, () => renew(s));
              }}
            />
            <MenuItem
              icon="upload"
              label="更新快照并续期"
              sublabel="用当前最新内容覆盖接收者看到的版本"
              onClick={() => {
                close();
                void withBusy(s, () => refreshExport(s));
              }}
            />
          </>
        )}
        <MenuSep />
        <MenuItem
          icon="trash"
          label={st.state === "cleanup_pending" ? "重试撤销" : "撤销"}
          danger
          onClick={() => {
            close();
            void withBusy(s, () => revoke(s));
          }}
        />
      </>
    ));
  };

  const openSourceMenu = (e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const present = SOURCE_KINDS.filter((k) => (sourceCounts[k] ?? 0) > 0);
    openMenu(
      { rect },
      (close) => (
        <>
          <MenuLabel>来源</MenuLabel>
          <MenuItem
            label="全部来源"
            checked={filter.source === "all"}
            onClick={() => {
              close();
              setFilter((f) => ({ ...f, source: "all" }));
            }}
          />
          {present.map((k) => (
            <MenuItem
              key={k}
              label={SOURCE_KIND_LABEL[k]}
              sublabel={`${sourceCounts[k]} 个分享`}
              checked={filter.source === k}
              onClick={() => {
                close();
                setFilter((f) => ({ ...f, source: k }));
              }}
            />
          ))}
        </>
      ),
      { minWidth: 180 },
    );
  };

  const clearExpired = async (rows: ShareListItem[]) => {
    const ok = await confirmDialog({
      title: `清理 ${rows.length} 个已过期分享？`,
      message: "记录将被删除。设备与 Edge 分享如需再次公开，可以重新分享。",
      confirmLabel: "清理",
      danger: true,
    });
    if (!ok) return;
    setClearing(true);
    let done = 0;
    let firstErr: string | null = null;
    for (const s of rows) {
      try {
        await api.revokeShare(s.slug, s.sourceUrl);
        done++;
      } catch (e) {
        firstErr ??= (e as Error).message;
      }
    }
    setClearing(false);
    toast(firstErr ? `已清理 ${done} 个，${rows.length - done} 个失败：${firstErr}` : `已清理 ${done} 个分享`);
    notifySharesChanged();
    reload();
  };

  const renderRow = (s: ShareListItem) => {
    const st = shareStatus(s, now);
    const pa = primaryAction(s, st);
    const isBusy = busy.has(s.slug);
    const expiredRow = st.state === "expired";
    const s3 = s.transport === "s3";
    return (
      <li class={"shv-row st-" + st.state} key={s.slug}>
        <span class={"shv-ico k-" + s.kind}>
          <Icon name={KIND_ICON[s.kind] ?? "file"} />
        </span>
        <div class="shv-main">
          <button class="shv-title" onClick={() => openObject(s)} title={OPEN_OBJECT_LABEL[s.kind] ?? "打开原对象"}>
            {s.title}
          </button>
          <div class="shv-sub">
            {s3 ? (
              <span class="shv-snap" title="存储桶分享是一份快照；链接需续签后生成">
                {s.contentUpdatedAt ? fmtSnapshot(s.contentUpdatedAt, now) : "快照链接"}
              </span>
            ) : s.url ? (
              <button
                class="shv-link"
                disabled={expiredRow || isBusy}
                title={expiredRow ? "链接已过期" : `${s.url}\n点击复制`}
                onClick={() => withBusy(s, () => copyShare(s))}
              >
                <span class="shv-link-text">{displayUrl(s.url)}</span>
                <Icon name="copy" cls="ico" />
              </button>
            ) : null}
            {filter.source === "all" && (
              <>
                <span class="shv-sep">·</span>
                <span>{sourceLabel(s)}</span>
              </>
            )}
            {s.permission === "edit" && (
              <>
                <span class="shv-sep">·</span>
                <span class="shv-perm edit">可编辑</span>
              </>
            )}
            {s.hasPassword && (
              <>
                <span class="shv-sep">·</span>
                <span class="shv-lock" title="口令保护"><Icon name="lock" cls="ico" /></span>
              </>
            )}
          </div>
        </div>
        <span class={"shv-status tone-" + st.tone}>
          {st.tone === "busy" ? <span class="sync-ring" aria-hidden="true" /> : <span class="shv-dot" aria-hidden="true" />}
          {st.label}
        </span>
        <div class="shv-actions">
          <button
            class={"btn btn-secondary" + (pa.danger ? " txt-danger" : "")}
            disabled={pa.disabled || isBusy}
            onClick={() => void runPrimary(s, pa)}
          >
            {isBusy ? "处理中…" : pa.label}
          </button>
          <button class="iconbtn" title="更多" onClick={(e) => openRowMenu(e as unknown as MouseEvent, s, st)}>
            <Icon name="dots" />
          </button>
        </div>
      </li>
    );
  };

  return (
    <div class="db shares-page">
      <div class="db-head">
        <div>
          <div class="db-title">分享</div>
          <div class="db-desc">所有对外公开的链接都在这里：谁能看、看到哪个版本、还能看多久。</div>
        </div>
        <div class="shv-tools">
          <div class="shv-seg" role="tablist">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={filter.status === f.id}
                class={"shv-seg-btn" + (filter.status === f.id ? " active" : "")}
                onClick={() => setFilter((x) => ({ ...x, status: f.id }))}
              >
                {f.label}
                {/* always rendered so the count arriving doesn't widen the bar */}
                <span class={"n" + (shares == null ? " ph" : "")}>{shares == null ? "–" : counts[f.id]}</span>
              </button>
            ))}
          </div>
          <button
            class={"btn btn-secondary shv-src" + (filter.source !== "all" ? " on" : "")}
            title="按来源筛选"
            onClick={(e) => openSourceMenu(e as unknown as MouseEvent)}
          >
            {filter.source === "all" ? "全部来源" : SOURCE_KIND_LABEL[filter.source]}
            <Icon name="chevronDown" cls="ico" />
          </button>
          <div class="shv-search">
            <Icon name="search" cls="ico sm" />
            <input
              placeholder="搜索标题 / 链接…"
              value={filter.q}
              onInput={(e) => {
                const q = (e.currentTarget as HTMLInputElement).value;
                setFilter((f) => ({ ...f, q }));
              }}
            />
          </div>
        </div>
      </div>

      {shares == null && loadErr != null ? (
        <div class="site-empty">
          <div class="ei"><Icon name="cloudOff" /></div>
          <div class="et">分享列表加载失败</div>
          <div class="ed">{loadErr}</div>
          <button class="btn btn-secondary" onClick={reload}>重试</button>
        </div>
      ) : shares == null ? (
        <ShareListSkeleton rows={skelRows} />
      ) : shares.length === 0 ? (
        <div class="site-empty">
          <div class="ei"><Icon name="link" /></div>
          <div class="et">还没有分享出去的内容</div>
          <div class="ed">在文档、表格或站点里点「分享」即可创建链接。</div>
        </div>
      ) : shown.length === 0 ? (
        <div class="site-empty">
          <div class="ei"><Icon name="search" /></div>
          <div class="et">没有匹配的分享</div>
          <div class="ed">换个关键词，或清除当前的状态与来源筛选。</div>
          {filtered && (
            <button class="btn btn-secondary" onClick={() => setFilter(EMPTY_FILTER)}>清除筛选</button>
          )}
        </div>
      ) : (
        <>
          {live.length > 0 && <ul class="shv-list">{live.map(renderRow)}</ul>}
          {expired.length > 0 && (
            <>
              {filter.status !== "expired" && (
                <div class="shv-group-head">
                  已过期<span class="n">{expired.length}</span>
                  <button class="btn btn-secondary" disabled={clearing} onClick={() => void clearExpired(expired)}>
                    {clearing ? "清理中…" : "清理全部已过期"}
                  </button>
                </div>
              )}
              <ul class="shv-list">{expired.map(renderRow)}</ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
