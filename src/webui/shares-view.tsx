/** @jsxImportSource preact */
// Global "分享" view — a top-level pane (parallel to 站点/Sites) listing every
// share this node can see: its local server shares + each attached bucket + each
// paired peer (aggregated server-side, see share-actions listSharesAggregated).
// Per-object management still lives in the share dialog; this is the bird's-eye
// list with copy / open / renew / revoke + a transport filter and title search.

import { useEffect, useMemo, useState } from "preact/hooks";
import { api, type ShareListItem } from "./api.ts";
import { Icon } from "./icons.tsx";
import { toast } from "./ui.tsx";
import { useShareActions, SHARES_CHANGED } from "./share-modal.tsx";
import type { Navigate } from "./view.ts";

const KIND_ICON: Record<string, string> = { doc: "file", database: "database", site: "globe" };

function fmtExpiry(ts: number | null): { text: string; warn: boolean; dead: boolean } {
  if (ts == null) return { text: "永久", warn: false, dead: false };
  const ms = ts - Date.now();
  if (ms <= 0) return { text: "已过期", warn: true, dead: true };
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor(ms / 3_600_000);
  if (d >= 1) return { text: `${d} 天后过期`, warn: d <= 2, dead: false };
  if (h >= 1) return { text: `${h} 小时后过期`, warn: true, dead: false };
  return { text: "即将过期", warn: true, dead: false };
}

export function ShareView({ onNavigate }: { onNavigate: Navigate }) {
  const [shares, setShares] = useState<ShareListItem[] | null>(null);
  const [filter, setFilter] = useState<"all" | "server" | "s3">("all");
  const [q, setQ] = useState("");

  const reload = () =>
    api
      .listShares()
      .then(setShares)
      .catch((e) => toast(`加载失败：${e.message}`));

  useEffect(() => {
    reload();
    document.addEventListener(SHARES_CHANGED, reload);
    return () => document.removeEventListener(SHARES_CHANGED, reload);
  }, []);

  const { copyShare, revoke, renew } = useShareActions(reload, toast, toast);

  const shown = useMemo(() => {
    const list = shares ?? [];
    const needle = q.trim().toLowerCase();
    return list.filter(
      (s) =>
        (filter === "all" || s.transport === filter) &&
        (!needle || s.title.toLowerCase().includes(needle) || s.source.toLowerCase().includes(needle)),
    );
  }, [shares, filter, q]);

  const openObject = (s: ShareListItem) => {
    if (s.kind === "doc") onNavigate({ kind: "doc", id: s.target_id });
    else if (s.kind === "database") onNavigate({ kind: "db", id: s.target_id });
    else onNavigate({ kind: "sites" });
  };

  return (
    <div class="db shares-page">
      <div class="db-head">
        <div>
          <div class="db-title">分享</div>
          <div class="db-desc">通过服务器或对象存储对外分享的文档、表格与站点。</div>
        </div>
        <div class="shv-tools">
          <div class="shv-seg" role="tablist">
            {(["all", "server", "s3"] as const).map((f) => (
              <button
                key={f}
                class={"shv-seg-btn" + (filter === f ? " active" : "")}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "全部" : f === "server" ? "服务器" : "对象存储"}
              </button>
            ))}
          </div>
          <div class="shv-search">
            <Icon name="search" cls="ico sm" />
            <input
              placeholder="搜索标题 / 来源…"
              value={q}
              onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)}
            />
          </div>
        </div>
      </div>

      {shares == null ? (
        <div class="muted" style={{ padding: 20 }}>
          加载中…
        </div>
      ) : shown.length === 0 ? (
        <div class="site-empty">
          <div class="ei"><Icon name="link" /></div>
          <div class="et">{shares.length === 0 ? "还没有公开分享" : "没有匹配的分享"}</div>
          <div class="ed">
            在文档、表格或站点里点「通过设备分享」即可创建——可经服务器（支持可编辑）或对象存储（只读、端到端加密）。
          </div>
        </div>
      ) : (
        <ul class="shv-list">
          {shown.map((s) => {
            const exp = fmtExpiry(s.expiresAt);
            return (
              <li class="shv-row" key={s.slug}>
                <span class={"shv-ico k-" + s.kind}>
                  <Icon name={KIND_ICON[s.kind] ?? "file"} />
                </span>
                <div class="shv-main">
                  <div class="shv-titleline">
                    <button class="shv-title" onClick={() => openObject(s)} title="打开对象">
                      {s.title}
                    </button>
                    <span class={"shv-pill t-" + s.transport}>
                      {s.transport === "s3" ? "对象存储" : "服务器"}
                    </span>
                    <span class={"shv-pill p-" + s.permission}>
                      {s.permission === "edit" ? "可编辑" : "只读"}
                    </span>
                    {s.hasPassword && <span class="shv-lock" title="口令保护">🔒</span>}
                  </div>
                  <div class="shv-meta">
                    经 {s.source}
                    <span class={"shv-exp" + (exp.warn ? " warn" : "") + (exp.dead ? " dead" : "")}>
                      {" · "}
                      {exp.text}
                    </span>
                  </div>
                </div>
                <div class="shv-actions">
                  <button class="btn btn-secondary" onClick={() => copyShare(s)}>复制链接</button>
                  {s.transport === "s3" && (
                    <button class="btn btn-secondary" onClick={() => renew(s)}>续期</button>
                  )}
                  {s.url && (
                    <a class="btn btn-secondary" href={s.url} target="_blank" rel="noreferrer">打开</a>
                  )}
                  <button class="btn btn-danger" onClick={() => revoke(s)}>撤销</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
