/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  api,
  type AuditEntity,
  type AuditEntry,
  type AuditEntryDetail,
  type NodeInfo,
} from "../api.ts";
import { Icon } from "../icons.tsx";
import { timeAgo } from "../date.ts";
import { toast, confirmDialog } from "../ui.tsx";
import { KindBadge, fmtVal } from "../history.tsx";
import { groupLabel } from "../hist-diff.ts";
import { SYNCED_EVENT } from "../data/replica.ts";
import { PageHeader } from "./primitives.tsx";
import { pageLabel } from "./nav.ts";

// The workspace audit page: the global change feed (core/audit.ts) rendered as
// a Notion-style activity list, with actor filtering and per-entry rollback.
// Its reason to exist: AI agents drive the CLI against the same hub — every
// agent-minted txn carries the "ai" actor tag, so this page is where you
// review what the agent did and undo a bad batch in one click.

const PAGE_SIZE = 50;

const DATASET_LABEL: Record<string, string> = {
  records: "记录",
  documents: "文档",
  properties: "字段",
  databases: "数据库",
  sites: "站点",
  site_channels: "站点渠道",
  site_files: "站点文件",
  doc_blocks: "文档块",
  blob_policy: "附件策略",
};

type Filter = "all" | "ai" | "self" | "others";

function entityVerb(e: AuditEntity): string {
  if (e.created) return "创建";
  if (e.deleted) return "删除";
  return "修改";
}

function entityHash(e: AuditEntity): string | null {
  if (e.dataset === "records" && e.database_id)
    return `#/db/${encodeURIComponent(e.database_id)}/${encodeURIComponent(e.id)}`;
  if (e.dataset === "documents") return `#/doc/${encodeURIComponent(e.id)}`;
  if (e.dataset === "databases") return `#/db/${encodeURIComponent(e.id)}`;
  if (e.dataset === "properties" && e.database_id)
    return `#/db/${encodeURIComponent(e.database_id)}`;
  return null;
}

function ActorBadge({ entry, nodeName }: { entry: AuditEntry; nodeName: (id: string) => string }) {
  if (entry.actor === "ai") return <span class="audit-actor ai">AI</span>;
  if (entry.actor) return <span class="audit-actor">{entry.actor}</span>;
  return <span class="audit-actor node">{nodeName(entry.node_id)}</span>;
}

/** One entity line inside an expanded entry: per-field old→new diffs. */
function EntityDiffs({ ent, created }: { ent: AuditEntryDetail["entities"][number]; created: boolean }) {
  const diffs = [...ent.diffs, ...ent.block_diffs];
  if (!diffs.length) return null;
  return (
    <div class="hist-fields">
      {diffs.map((d) => (
        <div key={d.col} class="hist-field">
          <span class="fname">{d.label === "block" ? "段落" : d.label}</span>
          {!created && (
            <span class="old" title={fmtVal(d.before)}>
              {fmtVal(d.before)}
            </span>
          )}
          {!created && <span class="arr">→</span>}
          <span class="new" title={fmtVal(d.after)}>
            {fmtVal(d.after)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [details, setDetails] = useState<Map<string, AuditEntryDetail>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  // Newest version currently shown — SYNCED_EVENT refetches flash-mark
  // anything newer ("the AI just did this" cue, same as quickboard).
  const headRef = useRef<string | null>(null);

  const nodeName = (id: string): string => {
    const n = nodes.find((n) => n.node_id === id);
    if (n?.self) return "本设备";
    return n?.label || id.slice(0, 8);
  };
  const selfNode = nodes.find((n) => n.self)?.node_id;

  useEffect(() => {
    api.nodes().then(setNodes).catch(() => {});
  }, []);

  const load = (opts: { flashNew?: boolean } = {}) => {
    api
      .auditList({ limit: PAGE_SIZE, actor: filter === "ai" ? "ai" : undefined })
      .then((page) => {
        if (opts.flashNew && headRef.current) {
          const head = headRef.current;
          const fresh = page.entries.filter((e) => e.version > head).map((e) => e.version);
          if (fresh.length) {
            setFlash(new Set(fresh));
            setTimeout(() => setFlash(new Set()), 1500);
          }
        }
        headRef.current = page.entries[0]?.version ?? headRef.current;
        setEntries(page.entries);
        setNext(page.next);
      })
      .catch((e) => toast(String((e as Error).message)));
  };

  useEffect(() => {
    setEntries(null);
    headRef.current = null;
    load();
    // Live: any synced change (own edits, agent CLI writes via the SSE poke,
    // peer sync) re-pulls the first page. Debounced by live.ts already.
    const onSync = () => load({ flashNew: true });
    document.addEventListener(SYNCED_EVENT, onSync);
    return () => document.removeEventListener(SYNCED_EVENT, onSync);
  }, [filter]);

  const loadMore = () => {
    if (!next) return;
    api
      .auditList({ limit: PAGE_SIZE, before: next, actor: filter === "ai" ? "ai" : undefined })
      .then((page) => {
        setEntries((cur) => [...(cur ?? []), ...page.entries]);
        setNext(page.next);
      })
      .catch((e) => toast(String((e as Error).message)));
  };

  const toggle = (e: AuditEntry) => {
    const key = e.version;
    const open = new Set(expanded);
    if (open.has(key)) {
      open.delete(key);
      setExpanded(open);
      return;
    }
    open.add(key);
    setExpanded(open);
    if (e.txn && !details.has(e.txn)) {
      api
        .auditEntry(e.txn)
        .then((d) => setDetails((m) => new Map(m).set(e.txn!, d)))
        .catch((err) => toast(String((err as Error).message)));
    }
  };

  const revert = async (e: AuditEntry) => {
    if (!e.txn) return;
    const ok = await confirmDialog({
      title: "撤销这次改动？",
      message:
        "以一次新的正向修改恢复到改动前的状态（本身可再撤销）。之后被其他编辑覆盖过的字段会保留，不会被回退。",
      confirmLabel: "撤销改动",
      danger: true,
    });
    if (!ok) return;
    setBusy(e.txn);
    try {
      const r = await api.auditRevert(e.txn);
      const kept = r.skipped_registers + r.skipped_rows;
      toast(
        r.changed
          ? `已恢复 ${r.restored_registers + r.removed_rows} 项` +
              (kept ? `，保留了 ${kept} 项更晚的编辑` : "")
          : "无需恢复：已是改动前的状态",
      );
      load();
    } catch (err) {
      toast(String((err as Error).message));
    } finally {
      setBusy(null);
    }
  };

  const visible = useMemo(
    () =>
      (entries ?? []).filter((e) => {
        if (filter === "self") return !e.actor && (!selfNode || e.node_id === selfNode);
        if (filter === "others") return !e.actor && selfNode != null && e.node_id !== selfNode;
        return true; // all | ai (ai narrowed server-side)
      }),
    [entries, filter, selfNode],
  );

  // Time-bucketed like the doc history timeline (今天/昨天/本周/…).
  const groups = useMemo(() => {
    const out: { label: string; items: AuditEntry[] }[] = [];
    for (const e of visible) {
      const label = groupLabel(e.at);
      if (out[out.length - 1]?.label !== label) out.push({ label, items: [] });
      out[out.length - 1]!.items.push(e);
    }
    return out;
  }, [visible]);

  const FILTERS: { id: Filter; label: string }[] = [
    { id: "all", label: "全部" },
    { id: "ai", label: "AI 操作" },
    { id: "self", label: "本设备" },
    { id: "others", label: "其他设备" },
  ];

  return (
    <>
      <PageHeader
        title={pageLabel("audit")}
        sub="工作区里每一次改动的统一流水：谁在什么时候改了什么。AI 通过命令行做的操作会标注出来，可以逐条检查并一键撤销。"
      />
      <div class="audit-filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            class={"audit-chip" + (filter === f.id ? " on" : "")}
            onClick={() => setFilter(f.id)}
          >
            {f.id === "ai" && <span class="audit-chip-dot" />}
            {f.label}
          </button>
        ))}
      </div>
      <div class="audit-feed">
        {entries === null && <div class="muted pad">加载中…</div>}
        {entries !== null && visible.length === 0 && (
          <div class="muted pad">
            {filter === "ai" ? "还没有 AI 操作的记录。" : "暂无改动记录。"}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label} class="audit-group">
            <div class="audit-group-label">{g.label}</div>
            {g.items.map((e) => {
              const open = expanded.has(e.version);
              const detail = e.txn ? details.get(e.txn) : undefined;
              return (
                <div
                  key={e.version}
                  class={"audit-item" + (flash.has(e.version) ? " flash" : "")}
                >
                  <div class="audit-item-line" onClick={() => toggle(e)}>
                    <span class="audit-when" title={new Date(e.at).toLocaleString()}>
                      {timeAgo(e.at)}
                    </span>
                    <ActorBadge entry={e} nodeName={nodeName} />
                    <KindBadge kind={e.kind} />
                    <span class="audit-summary">
                      {e.entities.map((ent, i) => (
                        <span key={ent.dataset + ent.id}>
                          {i > 0 && "、"}
                          {entityVerb(ent)}
                          {DATASET_LABEL[ent.dataset] ?? ent.dataset}
                          <a
                            class="audit-ent"
                            href={entityHash(ent) ?? undefined}
                            onClick={(ev) => ev.stopPropagation()}
                          >
                            {ent.label || ent.id.slice(0, 12)}
                          </a>
                          {ent.database_label && ent.dataset !== "databases" && (
                            <span class="audit-dbname">（{ent.database_label}）</span>
                          )}
                        </span>
                      ))}
                    </span>
                    <span class="audit-spacer" />
                    {e.txn && (
                      <button
                        class="btn btn-ghost audit-revert"
                        disabled={busy === e.txn}
                        title="以一次新的正向修改撤销这组改动"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          void revert(e);
                        }}
                      >
                        <Icon name="history" cls="ico sm" />
                        撤销
                      </button>
                    )}
                    <Icon name={open ? "chevronDown" : "chevron"} cls="ico sm audit-caret" />
                  </div>
                  {open && (
                    <div class="audit-detail">
                      {!e.txn && <div class="muted">早期版本的改动，仅可查看摘要。</div>}
                      {e.txn && !detail && <div class="muted">加载中…</div>}
                      {detail?.entities.map((ent) => (
                        <div key={ent.dataset + ent.id} class="audit-detail-ent">
                          {detail.entities.length > 1 && (
                            <div class="audit-detail-ent-name">
                              {DATASET_LABEL[ent.dataset] ?? ent.dataset}·{ent.label || ent.id}
                            </div>
                          )}
                          {(ent.blocks_changed > 0 || ent.blocks_deleted > 0) && (
                            <div class="audit-blocks muted">
                              {ent.blocks_changed > 0 && `${ent.blocks_changed} 块修改`}
                              {ent.blocks_changed > 0 && ent.blocks_deleted > 0 && "，"}
                              {ent.blocks_deleted > 0 && `${ent.blocks_deleted} 块删除`}
                            </div>
                          )}
                          <EntityDiffs ent={ent} created={ent.created} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {next && (
          <button class="btn btn-secondary audit-more" onClick={loadMore}>
            加载更早的记录
          </button>
        )}
        {entries !== null && (
          <div class="audit-foot muted">
            记录深度受历史压缩窗口限制（默认约 90 天）；更早的改动已合并为基线，不可再撤销。
          </div>
        )}
      </div>
    </>
  );
}
