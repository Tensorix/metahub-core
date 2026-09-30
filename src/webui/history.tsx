/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  api,
  ApiError,
  type Doc,
  type DocRevision,
  type DocVersionState,
  type NodeInfo,
  type RevisionKind,
} from "./api.ts";
import { Icon } from "./icons.tsx";
import { SkelLines } from "./skeleton.tsx";
import { timeAgo } from "./date.ts";
import { t } from "./i18n/t.ts";
import { fmtDate } from "./i18n/fmt.ts";
import { confirmDialog, toast, useDrawerResize, useDrawerTransition } from "./ui.tsx";
import { renderMarkdown, type RenderOpts } from "../core/sync/share-render.ts";
import { docLinkTitle } from "./doc-titles.ts";
import {
  buildDocTimeline,
  diffLines,
  foldSame,
  richDiffSections,
  type DiffLine,
  type TimelineEntry,
} from "./hist-diff.ts";

// Document version history drawer. Reads the oplog-backed /api/document/*
// endpoints; restore is a forward write on the server (the revert itself
// becomes a new revision), so nothing here ever rewrites history.
//
// Diff semantics are GitHub-like: a revision diffs against its PREVIOUS
// revision by default ("what did this edit change"), against a pinned base
// when the user picks one. Record/activity panels live in history-record.tsx.

const KIND_LABEL: Record<RevisionKind, string> = { user: "", repair: t("修复"), revert: t("回滚") };

/** node_id -> display name ("本设备" / pairing label / short id). */
export function useNodeNames(): (id: string) => string {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  useEffect(() => {
    api.nodes().then(setNodes).catch(() => {});
  }, []);
  return (id: string) => {
    const n = nodes.find((n) => n.node_id === id);
    if (n?.self) return t("本设备");
    return n?.label || id.slice(0, 8);
  };
}

export function KindBadge({ kind }: { kind: RevisionKind }) {
  if (kind === "user") return null;
  return <span class={"hist-kind " + kind}>{KIND_LABEL[kind]}</span>;
}

export function fmtVal(v: unknown): string {
  if (v === undefined) return t("（空）");
  if (v === null) return t("（空）");
  if (typeof v === "string") return v === "" ? t("（空）") : v;
  return JSON.stringify(v);
}

/** HLC version token -> wall-clock millis (first 15 digits). */
export function timeFromVersion(version: string): number {
  return Number(version.slice(0, 15)) || Date.now();
}

// ---- document history drawer -------------------------------------------------

function docSummary(r: DocRevision): string {
  const parts: string[] = [];
  if (r.created) parts.push(t("创建"));
  if (r.deleted) parts.push(t("删除"));
  if (r.title_changed) parts.push(t("标题"));
  if (r.blocks_changed) parts.push(t("{n} 块修改", { n: r.blocks_changed }));
  if (r.blocks_deleted) parts.push(t("{n} 块删除", { n: r.blocks_deleted }));
  return parts.join(t("、")) || t("元数据");
}

type Mode = "changes" | "source" | "preview";
const MODE_LABEL: Record<Mode, string> = { changes: t("变更"), source: t("源码"), preview: t("预览") };

/** Rendered rich-text diff for non-technical reading: the document as it looks,
 *  with word-level <del>/<ins> marks and washed added/removed blocks. Long
 *  unchanged runs fold behind an expander. Remounted (keyed) per comparison so
 *  fold state resets with the selection. */
function RichDiff({
  base,
  target,
  render,
}: {
  base: string;
  target: string;
  render: (md: string) => string;
}) {
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const sections = useMemo(() => richDiffSections(base, target, render), [base, target, render]);
  return (
    <div class="hist-md hist-rich">
      {sections.map((s, i) =>
        s.kind === "rows" || opened.has(i) ? (
          <div key={i} dangerouslySetInnerHTML={{ __html: s.html }} />
        ) : (
          <button
            key={"f" + i}
            class="hist-fold"
            onClick={() => setOpened(new Set(opened).add(i))}
          >
            <Icon name="chevronDown" cls="ico sm" />
            {t("展开 {n} 个未变更块", { n: s.blocks })}
          </button>
        ),
      )}
    </div>
  );
}

/** GitHub-style unified diff: line-number gutters, +/- markers, intra-line
 *  emphasis, long unchanged runs folded behind an expander. Remounted (keyed)
 *  per comparison so fold state resets with the selection. */
function GhDiff({ rows }: { rows: DiffLine[] }) {
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const sections = useMemo(() => foldSame(rows), [rows]);
  const line = (r: DiffLine, i: number) => (
    <div key={i} class={"hist-dl " + r.kind + (r.mono ? " mono" : "")}>
      <span class="no">{r.oldNo ?? ""}</span>
      <span class="no">{r.newNo ?? ""}</span>
      <span class="mark">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
      <span class="txt">
        {r.seg ? (
          <>
            {r.seg[0]}
            <span class="seg">{r.seg[1]}</span>
            {r.seg[2]}
          </>
        ) : (
          // A real blank line still needs row height.
          r.text || " "
        )}
      </span>
    </div>
  );
  return (
    <div class="hist-gh">
      {sections.map((s, si) =>
        s.kind === "rows" || opened.has(si) ? (
          s.rows.map(line)
        ) : (
          <button
            key={"f" + si}
            class="hist-fold"
            onClick={() => setOpened(new Set(opened).add(si))}
          >
            <Icon name="chevronDown" cls="ico sm" />
            {t("展开 {n} 行未变更内容", { n: s.rows.length })}
          </button>
        ),
      )}
    </div>
  );
}

/** Cache slot: a fetched version state, or "missing" (compacted away). */
type CachedState = DocVersionState | "missing";

export function DocHistoryPanel({
  docId,
  onClose,
  onReverted,
}: {
  docId: string;
  onClose: () => void;
  onReverted: () => void;
}) {
  const { open, close } = useDrawerTransition(onClose);
  const { width, handle } = useDrawerResize("mh.histPeekW", 480);
  const [revs, setRevs] = useState<DocRevision[] | null>(null);
  const [cur, setCur] = useState<Doc | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  /** Net-diff override set when a collapsed cluster is selected as a whole. */
  const [selBase, setSelBase] = useState<string | null>(null);
  /** User-pinned compare base (shift-click / pin button); beats selBase. */
  const [pinnedBase, setPinnedBase] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("changes");
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openClusters, setOpenClusters] = useState<Set<string>>(new Set());
  const states = useRef(new Map<string, CachedState>());
  const inflight = useRef(new Set<string>());
  const [, bump] = useState(0);
  const nodeName = useNodeNames();

  const load = () =>
    Promise.all([api.documentHistory(docId), api.getDocument(docId)])
      .then(([r, d]) => {
        setRevs(r);
        setCur(d);
        // Seed the cache with HEAD — opening the drawer selects it, no extra
        // /document/at round-trip needed.
        if (d.version)
          states.current.set(d.version, {
            id: d.id,
            title: d.title ?? "",
            body: d.body ?? "",
            deleted: false,
            version: d.version,
          });
        setSel((s) => s ?? r[0]?.version ?? null);
      })
      .catch((e) => toast(String((e as Error).message)));
  useEffect(() => {
    states.current.clear();
    setSel(null);
    setSelBase(null);
    setPinnedBase(null);
    load();
  }, [docId]);

  const fetchState = (version: string) => {
    if (states.current.has(version) || inflight.current.has(version)) return;
    inflight.current.add(version);
    api
      .documentAt(docId, version)
      .then((s) => states.current.set(version, s))
      .catch(() => states.current.set(version, "missing"))
      .finally(() => {
        inflight.current.delete(version);
        bump((n) => n + 1);
      });
  };

  const visible = useMemo(
    () => (revs ?? []).filter((r) => showAll || r.kind !== "repair"),
    [revs, showAll],
  );
  const timeline = useMemo(() => buildDocTimeline(visible), [visible]);

  const idxOf = (v: string | null) =>
    v == null ? -1 : (revs ?? []).findIndex((r) => r.version === v);

  // Default base = the next-older revision in the FULL list (repairs included:
  // hiding them must not re-attribute their changes to the next user edit).
  const selIdx = idxOf(sel);
  const defaultBase = selIdx >= 0 ? (revs![selIdx + 1]?.version ?? null) : null;
  // Pinned comparisons always diff old → new regardless of click order.
  let targetV = sel;
  let baseV = pinnedBase ?? selBase ?? defaultBase;
  if (pinnedBase && sel && pinnedBase > sel) {
    targetV = pinnedBase;
    baseV = sel;
  }

  useEffect(() => {
    if (targetV) fetchState(targetV);
    if (baseV) fetchState(baseV);
  }, [targetV, baseV]);

  const EMPTY = useMemo<DocVersionState>(
    () => ({ id: docId, title: "", body: "", deleted: false, version: "" }),
    [docId],
  );
  const rawTarget = targetV ? states.current.get(targetV) : undefined;
  const rawBase = baseV ? states.current.get(baseV) : undefined;
  const target = rawTarget === "missing" ? EMPTY : rawTarget;
  const base = baseV == null || rawBase === "missing" ? EMPTY : rawBase;
  const loading =
    (targetV != null && rawTarget === undefined) || (baseV != null && rawBase === undefined);
  const baseMissing = rawBase === "missing";
  const isHead = sel != null && revs?.[0]?.version === sel;
  const selRev = selIdx >= 0 ? revs![selIdx] : undefined;
  const isOldest = selIdx >= 0 && selIdx === revs!.length - 1;
  /** Oldest revision that isn't the document's creation: older history was
   *  compacted away — the "vs previous" diff degrades to "vs empty". */
  const compactEdge = baseMissing || (isOldest && !!selRev && !selRev.created && baseV == null);
  /** Pinned base equals the selection — a diff would be trivially empty. Only
   *  meaningful in the two diff modes; preview renders the snapshot anyway. */
  const sameCmp = pinnedBase != null && pinnedBase === sel && mode !== "preview";
  const pinnedRev = pinnedBase ? revs?.find((r) => r.version === pinnedBase) : undefined;

  const mdOpts = useMemo<RenderOpts>(
    () => ({
      resolveDocLink: (id) => {
        const title = docLinkTitle(id);
        return title ? { title } : null;
      },
    }),
    [],
  );
  const md = (text: string) => ({ __html: renderMarkdown(text, mdOpts) });
  const renderMd = useMemo(() => (text: string) => renderMarkdown(text, mdOpts), [mdOpts]);

  const lineRows = useMemo(
    () => (mode === "source" && base && target ? diffLines(base.body, target.body) : null),
    [mode, base, target],
  );

  const select = (v: string) => {
    setSel(v);
    setSelBase(null);
  };
  const togglePin = (v: string) => setPinnedBase((p) => (p === v ? null : v));

  /** Base for a cluster's net diff: the revision just before its oldest member. */
  const clusterNetBase = (revsInCluster: DocRevision[]) => {
    const oldest = revsInCluster[revsInCluster.length - 1]!;
    const i = idxOf(oldest.version);
    return i >= 0 ? (revs![i + 1]?.version ?? null) : null;
  };
  const toggleCluster = (c: Extract<TimelineEntry, { type: "cluster" }>) => {
    const key = c.revs[0]!.version;
    const next = new Set(openClusters);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpenClusters(next);
    // Either way, select the cluster's net change (newest member vs the state
    // before the run began) — collapsing keeps that as the collapsed row's diff.
    setSel(key);
    setSelBase(clusterNetBase(c.revs));
  };

  const restore = async () => {
    if (!sel || !target) return;
    const ok = await confirmDialog({
      title: t("恢复到此版本？"),
      message: t("标题和正文将恢复到 {when} 的状态。此操作会作为一次新修订记录，任何版本都仍可从历史找回。", { when: fmtDate(timeFromVersion(sel), "dateTime") }),
      confirmLabel: t("恢复"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.revertDocument(docId, { to: sel, if_match: cur?.version });
      toast(t("已恢复"));
      onReverted();
      close();
    } catch (e) {
      if (e instanceof ApiError && e.code === "stale") {
        toast(t("文档刚被其他端修改，已刷新，请重试"));
        states.current.clear();
        await load();
      } else {
        toast(String((e as Error).message));
      }
    } finally {
      setBusy(false);
    }
  };

  const revRow = (r: DocRevision) => (
    <div
      key={r.version}
      class={
        "hist-item" +
        (sel === r.version ? " sel" : "") +
        (pinnedBase === r.version ? " is-base" : "")
      }
      onClick={(ev) => (ev.shiftKey ? togglePin(r.version) : select(r.version))}
    >
      <div class="row1">
        <span class="when" title={fmtDate(r.at, "dateTime")}>
          {timeAgo(r.at)}
        </span>
        <KindBadge kind={r.kind} />
        {revs?.[0]?.version === r.version && <span class="hist-now">{t("当前")}</span>}
        <div style={{ flex: 1 }} />
        <button
          class="hist-pin"
          title={pinnedBase === r.version ? t("取消对比基准") : t("设为对比基准（Shift+点击）")}
          onClick={(ev) => {
            ev.stopPropagation();
            togglePin(r.version);
          }}
        >
          <Icon name="pin" cls="ico sm" />
        </button>
      </div>
      <div class="row2">
        <span class="who">{nodeName(r.node_id)}</span>
        <span class="what">{docSummary(r)}</span>
      </div>
    </div>
  );

  const clusterRow = (c: Extract<TimelineEntry, { type: "cluster" }>) => {
    const key = c.revs[0]!.version;
    const isOpen = openClusters.has(key);
    const selInside = c.revs.some((r) => r.version === sel);
    return (
      <div key={"c" + key}>
        <div
          class={"hist-item hist-cluster" + (!isOpen && selInside ? " sel" : "")}
          onClick={() => toggleCluster(c)}
        >
          <div class="row1">
            <span class="when" title={fmtDate(c.revs[0]!.at, "dateTime")}>
              {timeAgo(c.revs[0]!.at)}
            </span>
            <div style={{ flex: 1 }} />
            <Icon name={isOpen ? "chevronDown" : "chevron"} cls="ico sm" />
          </div>
          <div class="row2">
            <span class="who">{nodeName(c.revs[0]!.node_id)}</span>
            <span class="what">{t("{n} 次连续小修改", { n: c.revs.length })}</span>
          </div>
        </div>
        {isOpen && <div class="hist-cluster-kids">{c.revs.map(revRow)}</div>}
      </div>
    );
  };

  const titleChanged =
    mode !== "preview" && !!baseV && !baseMissing && !!base && !!target && base.title !== target.title;

  return (
    <>
      <div class={"scrim" + (open ? " open" : "")} onClick={close} />
      <div
        class={"peek hist-peek" + (open ? " open" : "")}
        style={width != null ? { width: `${width}px` } : undefined}
      >
        {handle}
        <div class="peek-head">
          <button class="iconbtn" onClick={close}>
            <Icon name="x" />
          </button>
          <span class="hist-title">
            <Icon name="history" cls="ico sm" />
            {t("版本历史")}
          </span>
          <div style={{ flex: 1 }} />
          <div class="hist-modes">
            {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
              <button
                key={m}
                class={"hist-mode" + (mode === m ? " on" : "")}
                onClick={() => setMode(m)}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <label class="hist-toggle">
            <input type="checkbox" checked={showAll} onInput={() => setShowAll(!showAll)} />
            {t("显示修复")}
          </label>
        </div>
        <div class="hist-split">
          <div class="hist-list">
            {revs === null && <SkelLines n={4} cls="pad" />}
            {timeline.map((g, gi) => (
              <div key={gi + ":" + g.label}>
                <div class="hist-group">{g.label}</div>
                {g.entries.map((e) => (e.type === "rev" ? revRow(e.rev) : clusterRow(e)))}
              </div>
            ))}
          </div>
          <div class="hist-preview">
            {pinnedRev && (
              <div class="hist-basechip">
                {t("对比基准：{when}", { when: timeAgo(pinnedRev.at) })}
                <button title={t("清除基准")} onClick={() => setPinnedBase(null)}>
                  <Icon name="x" cls="ico sm" />
                </button>
              </div>
            )}
            {target && target.deleted && <div class="hist-banner">{t("此修订删除了文档")}</div>}
            {mode !== "preview" && selRev?.created && isOldest && (
              <div class="hist-tag">{t("初始版本")}</div>
            )}
            {mode !== "preview" && compactEdge && !sameCmp && (
              <div class="hist-hint">{t("更早的修订已被存储压缩合并，此处按整篇新增显示")}</div>
            )}
            {sameCmp && <div class="muted pad">{t("两个版本相同。")}</div>}
            {!sameCmp && target && !loading && (
              <>
                <div class="hist-doc-title">
                  {titleChanged ? (
                    <>
                      <del>{base!.title || t("无标题")}</del>
                      <span class="hist-title-arr">→</span>
                      {target.title || t("无标题")}
                    </>
                  ) : (
                    target.title || t("无标题")
                  )}
                </div>
                {mode === "preview" &&
                  (target.body ? (
                    <div class="hist-md" dangerouslySetInnerHTML={md(target.body)} />
                  ) : (
                    <div class="muted">{t("（空文档）")}</div>
                  ))}
                {mode === "changes" &&
                  base &&
                  (base.body === target.body ? (
                    target.body ? (
                      <div class="muted">{t("此修订未改动正文。")}</div>
                    ) : (
                      <div class="muted">{t("（空文档）")}</div>
                    )
                  ) : (
                    <RichDiff
                      key={(baseV ?? "") + "→" + (targetV ?? "")}
                      base={base.body}
                      target={target.body}
                      render={renderMd}
                    />
                  ))}
                {mode === "source" &&
                  lineRows &&
                  (lineRows.some((r) => r.kind !== "same") ? (
                    <GhDiff key={(baseV ?? "") + "→" + (targetV ?? "")} rows={lineRows} />
                  ) : lineRows.length === 0 ? (
                    <div class="muted">{t("（空文档）")}</div>
                  ) : (
                    <div class="muted">{t("此修订未改动正文。")}</div>
                  ))}
              </>
            )}
            {loading && sel && <SkelLines n={3} cls="pad" />}
          </div>
        </div>
        <div class="hist-foot">
          <button
            class="btn btn-primary"
            disabled={!sel || isHead || busy || !target || target.deleted}
            onClick={restore}
          >
            {t("恢复到此版本")}
          </button>
        </div>
      </div>
    </>
  );
}
