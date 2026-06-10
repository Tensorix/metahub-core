/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  api,
  ApiError,
  type Doc,
  type DocRevision,
  type DocVersionState,
  type NodeInfo,
  type Prop,
  type Rec,
  type RecordRevision,
  type RecordVersionState,
  type RevisionKind,
} from "./api.ts";
import { Icon } from "./icons.tsx";
import { confirmDialog, toast, useDrawerTransition } from "./ui.tsx";

// Version history UI. Reads the oplog-backed /api/*/history endpoints; restore
// is a forward write on the server (the revert itself becomes a new revision),
// so nothing here ever rewrites history.

const KIND_LABEL: Record<RevisionKind, string> = { user: "", repair: "修复", revert: "回滚" };

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "刚刚";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  if (ms < 30 * 86_400_000) return `${Math.floor(ms / 86_400_000)} 天前`;
  return new Date(iso).toLocaleDateString();
}

/** node_id -> display name ("本设备" / pairing label / short id). */
function useNodeNames(): (id: string) => string {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  useEffect(() => {
    api.nodes().then(setNodes).catch(() => {});
  }, []);
  return (id: string) => {
    const n = nodes.find((n) => n.node_id === id);
    if (n?.self) return "本设备";
    return n?.label || id.slice(0, 8);
  };
}

function KindBadge({ kind }: { kind: RevisionKind }) {
  if (kind === "user") return null;
  return <span class={"hist-kind " + kind}>{KIND_LABEL[kind]}</span>;
}

// ---- block diff (display-only) ----------------------------------------------

/** Longest common subsequence pairs — same alignment rule the core reconcile
 *  uses, re-implemented here for display only (core/blocks.ts isn't bundled). */
function lcs(a: string[], b: string[]): [number, number][] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/** Blank-line blocks — only for the read-only (non-diff) preview rendering. */
const splitBlocks = (body: string): string[] => (body ? body.split(/\n{2,}/) : []);

/** Diff units are LINES (git-like), inside code fences too. Blank lines are
 *  separators, not content — letting them match each other only manufactures
 *  false alignments between unrelated regions. */
const splitLines = (body: string): string[] =>
  body ? body.split("\n").filter((l) => l.trim() !== "") : [];

type DiffRow = {
  kind: "same" | "add" | "del";
  text: string;
  /** Intra-line emphasis: [unchanged prefix, changed middle, unchanged suffix]. */
  seg?: [string, string, string];
};

/**
 * GitHub-style intra-line marks: the i-th deleted line in a gap pairs with the
 * i-th added line; stripping their common prefix/suffix leaves the middle that
 * actually changed. Lines that share too little read as a rewrite, not an
 * in-place edit — no marks for those (a fully-dark line is just noise).
 */
function markSegments(dels: DiffRow[], adds: DiffRow[]): void {
  for (let i = 0; i < Math.min(dels.length, adds.length); i++) {
    const o = dels[i]!.text;
    const n = adds[i]!.text;
    let p = 0;
    while (p < o.length && p < n.length && o[p] === n[p]) p++;
    let s = 0;
    while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++;
    if (p + s < Math.max(o.length, n.length) * 0.3) continue;
    dels[i]!.seg = [o.slice(0, p), o.slice(p, o.length - s), o.slice(o.length - s)];
    adds[i]!.seg = [n.slice(0, p), n.slice(p, n.length - s), n.slice(n.length - s)];
  }
}

/** What restoring `target` over `current` would do: del = lines that vanish,
 *  add = lines that come back. */
function diffLines(current: string, target: string): DiffRow[] {
  const a = splitLines(current);
  const b = splitLines(target);
  const keep = lcs(a, b);
  const rows: DiffRow[] = [];
  let ai = 0;
  let bi = 0;
  for (const [ka, kb] of [...keep, [a.length, b.length] as [number, number]]) {
    const dels: DiffRow[] = [];
    const adds: DiffRow[] = [];
    for (; ai < ka; ai++) dels.push({ kind: "del", text: a[ai]! });
    for (; bi < kb; bi++) adds.push({ kind: "add", text: b[bi]! });
    markSegments(dels, adds);
    rows.push(...dels, ...adds);
    if (ka < a.length) rows.push({ kind: "same", text: a[ka]! });
    ai = ka + 1;
    bi = kb + 1;
  }
  return rows;
}

// ---- document history drawer -------------------------------------------------

function docSummary(r: DocRevision): string {
  const parts: string[] = [];
  if (r.created) parts.push("创建");
  if (r.deleted) parts.push("删除");
  if (r.title_changed) parts.push("标题");
  if (r.blocks_changed) parts.push(`${r.blocks_changed} 块修改`);
  if (r.blocks_deleted) parts.push(`${r.blocks_deleted} 块删除`);
  return parts.join("、") || "元数据";
}

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
  const [revs, setRevs] = useState<DocRevision[] | null>(null);
  const [cur, setCur] = useState<Doc | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocVersionState | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [diff, setDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const nodeName = useNodeNames();

  const load = () =>
    Promise.all([api.documentHistory(docId), api.getDocument(docId)])
      .then(([r, d]) => {
        setRevs(r);
        setCur(d);
        setSel((s) => s ?? r[0]?.version ?? null);
      })
      .catch((e) => toast(String((e as Error).message)));
  useEffect(() => {
    load();
  }, [docId]);

  useEffect(() => {
    if (!sel) return setPreview(null);
    api.documentAt(docId, sel).then(setPreview).catch(() => setPreview(null));
  }, [docId, sel]);

  const visible = useMemo(
    () => (revs ?? []).filter((r) => showAll || r.kind !== "repair"),
    [revs, showAll],
  );
  const isHead = sel != null && revs?.[0]?.version === sel;

  const restore = async () => {
    if (!sel || !preview) return;
    const ok = await confirmDialog({
      title: "恢复到此版本？",
      message: `标题和正文将恢复到 ${new Date(preview.version ? timeFromVersion(preview.version) : Date.now()).toLocaleString()} 的状态。此操作会作为一次新修订记录，任何版本都仍可从历史找回。`,
      confirmLabel: "恢复",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.revertDocument(docId, { to: sel, if_match: cur?.version });
      toast("已恢复");
      onReverted();
      close();
    } catch (e) {
      if (e instanceof ApiError && e.code === "stale") {
        toast("文档刚被其他端修改，已刷新，请重试");
        await load();
      } else {
        toast(String((e as Error).message));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div class={"scrim" + (open ? " open" : "")} onClick={close} />
      <div class={"peek hist-peek" + (open ? " open" : "")}>
        <div class="peek-head">
          <button class="iconbtn" onClick={close}>
            <Icon name="x" />
          </button>
          <span class="hist-title">
            <Icon name="history" cls="ico sm" />
            版本历史
          </span>
          <div style={{ flex: 1 }} />
          <label class="hist-toggle">
            <input type="checkbox" checked={diff} onInput={() => setDiff(!diff)} />
            对比当前
          </label>
          <label class="hist-toggle">
            <input type="checkbox" checked={showAll} onInput={() => setShowAll(!showAll)} />
            显示修复
          </label>
        </div>
        <div class="hist-split">
          <div class="hist-list">
            {revs === null && <div class="muted pad">加载中…</div>}
            {visible.map((r) => (
              <div
                key={r.version}
                class={"hist-item" + (sel === r.version ? " sel" : "")}
                onClick={() => setSel(r.version)}
              >
                <div class="row1">
                  <span class="when" title={new Date(r.at).toLocaleString()}>
                    {timeAgo(r.at)}
                  </span>
                  <KindBadge kind={r.kind} />
                  {revs?.[0]?.version === r.version && <span class="hist-now">当前</span>}
                </div>
                <div class="row2">
                  <span class="who">{nodeName(r.node_id)}</span>
                  <span class="what">{docSummary(r)}</span>
                </div>
              </div>
            ))}
          </div>
          <div class="hist-preview">
            {preview && (
              <>
                <div class="hist-doc-title">{preview.title || "无标题"}</div>
                {diff && !isHead
                  ? diffLines(cur?.body ?? "", preview.body).map((row, i) => (
                      <div key={i} class={"hist-line " + row.kind}>
                        {row.seg ? (
                          <>
                            {row.seg[0]}
                            <span class="seg">{row.seg[1]}</span>
                            {row.seg[2]}
                          </>
                        ) : (
                          row.text
                        )}
                      </div>
                    ))
                  : splitBlocks(preview.body).map((text, i) => (
                      <div key={i} class="hist-block">
                        {text}
                      </div>
                    ))}
                {!preview.body && <div class="muted">（空文档）</div>}
              </>
            )}
            {!preview && sel && <div class="muted pad">加载中…</div>}
          </div>
        </div>
        <div class="hist-foot">
          <button class="btn btn-primary" disabled={!sel || isHead || busy} onClick={restore}>
            恢复到此版本
          </button>
        </div>
      </div>
    </>
  );
}

/** HLC version token -> wall-clock millis (first 15 digits). */
function timeFromVersion(version: string): number {
  return Number(version.slice(0, 15)) || Date.now();
}

// ---- record history (rendered inside the record peek) ------------------------

function recSummary(r: RecordRevision, names: Map<string, string>): string {
  const parts: string[] = [];
  if (r.created) parts.push("创建");
  if (r.deleted) parts.push("删除");
  if (r.fields.length)
    parts.push(r.fields.map((f) => names.get(f) ?? "（已删字段）").join("、"));
  if (r.moved && !parts.length) parts.push("排序");
  return parts.join("；") || "元数据";
}

function fmtVal(v: unknown): string {
  if (v === undefined) return "（空）";
  if (v === null) return "（空）";
  if (typeof v === "string") return v === "" ? "（空）" : v;
  return JSON.stringify(v);
}

export function RecordHistoryView({
  rec,
  props,
  onReverted,
}: {
  rec: Rec;
  props: Prop[];
  onReverted: () => void;
}) {
  const [revs, setRevs] = useState<RecordRevision[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const states = useRef(new Map<string, RecordVersionState>());
  const [, bump] = useState(0);
  const nodeName = useNodeNames();
  const names = useMemo(() => new Map(props.map((p) => [p.id, p.name])), [props]);

  const load = () =>
    api
      .recordHistory(rec.id)
      .then(setRevs)
      .catch((e) => toast(String((e as Error).message)));
  useEffect(() => {
    load();
  }, [rec.id]);

  const stateAt = async (version: string): Promise<RecordVersionState> => {
    const hit = states.current.get(version);
    if (hit) return hit;
    const s = await api.recordAt(rec.id, version);
    states.current.set(version, s);
    bump((n) => n + 1);
    return s;
  };

  const expand = (r: RecordRevision, prev: RecordRevision | undefined) => {
    if (expanded === r.version) return setExpanded(null);
    setExpanded(r.version);
    void stateAt(r.version);
    if (prev) void stateAt(prev.version);
  };

  const restore = async (r: RecordRevision) => {
    const ok = await confirmDialog({
      title: "恢复到此版本？",
      message: "记录字段将恢复到该修订时的值。此操作会作为一次新修订记录。",
      confirmLabel: "恢复",
    });
    if (!ok) return;
    try {
      await api.revertRecord(rec.id, r.version);
      toast("已恢复");
      states.current.clear();
      onReverted();
      await load();
    } catch (e) {
      toast(String((e as Error).message));
    }
  };

  const visible = (revs ?? []).filter((r) => showAll || r.kind !== "repair");

  return (
    <div class="hist-rec">
      <div class="hist-rec-head">
        <span class="hist-title">
          <Icon name="history" cls="ico sm" />
          修改历史
        </span>
        <label class="hist-toggle">
          <input type="checkbox" checked={showAll} onInput={() => setShowAll(!showAll)} />
          显示修复
        </label>
      </div>
      {revs === null && <div class="muted pad">加载中…</div>}
      {revs !== null && visible.length === 0 && <div class="muted pad">暂无历史。</div>}
      {visible.map((r, i) => {
        const prev = visible[i + 1];
        const curState = states.current.get(r.version);
        const prevState = prev ? states.current.get(prev.version) : undefined;
        const fields = r.created && curState ? Object.keys(curState.data) : r.fields;
        return (
          <div key={r.version} class="hist-item static">
            <div class="row1" onClick={() => expand(r, prev)}>
              <span class="when" title={new Date(r.at).toLocaleString()}>
                {timeAgo(r.at)}
              </span>
              <KindBadge kind={r.kind} />
              {i === 0 && <span class="hist-now">当前</span>}
              <div style={{ flex: 1 }} />
              <Icon name={expanded === r.version ? "chevronDown" : "chevron"} cls="ico sm" />
            </div>
            <div class="row2" onClick={() => expand(r, prev)}>
              <span class="who">{nodeName(r.node_id)}</span>
              <span class="what">{recSummary(r, names)}</span>
            </div>
            {expanded === r.version && (
              <div class="hist-fields">
                {!curState && <div class="muted">加载中…</div>}
                {curState &&
                  fields.map((f) => {
                    const before = prevState ? prevState.data[f] : undefined;
                    const after = curState.data[f];
                    return (
                      <div key={f} class="hist-field">
                        <span class="fname">{names.get(f) ?? "（已删字段）"}</span>
                        {prev && <span class="old">{fmtVal(before)}</span>}
                        {prev && <span class="arr">→</span>}
                        <span class="new">{fmtVal(after)}</span>
                      </div>
                    );
                  })}
                {curState && i !== 0 && (
                  <button class="btn btn-secondary hist-restore" onClick={() => restore(r)}>
                    恢复到此版本
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
