/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  api,
  type DatabaseActivityEntry,
  type FieldHistoryEntry,
  type Prop,
  type Rec,
  type RecordRevision,
  type RecordVersionState,
} from "./api.ts";
import { Icon } from "./icons.tsx";
import { timeAgo } from "./date.ts";
import { closeModal, confirmDialog, Modal, openModal, toast, useDrawerTransition } from "./ui.tsx";
import { fmtVal, KindBadge, useNodeNames } from "./history.tsx";

// Record-side history UIs: the database activity feed, the per-record revision
// list (inside the record peek) and the per-cell write trail modal. The
// document drawer lives in history.tsx.

// ---- cell-level write trail --------------------------------------------------

/** Full write trail of one record cell — every value it ever held. */
function FieldHistoryModal({
  recId,
  propId,
  propName,
}: {
  recId: string;
  propId: string;
  propName: string;
}) {
  const [entries, setEntries] = useState<FieldHistoryEntry[] | null>(null);
  const nodeName = useNodeNames();
  useEffect(() => {
    api
      .recordFieldHistory(recId, propId)
      .then(setEntries)
      .catch((e) => toast(String((e as Error).message)));
  }, [recId, propId]);
  return (
    <Modal
      title={`「${propName}」字段历史`}
      sub="该单元格的每一次写入，最新在前。"
      width={460}
      footer={
        <button class="btn btn-secondary" onClick={closeModal}>
          关闭
        </button>
      }
    >
      <div class="hist-fh">
        {entries === null && <div class="muted pad">加载中…</div>}
        {entries !== null && entries.length === 0 && <div class="muted pad">暂无写入记录。</div>}
        {(entries ?? []).map((e) => (
          <div key={e.version} class="hist-fh-row">
            <span class="when" title={new Date(e.at).toLocaleString()}>
              {timeAgo(e.at)}
            </span>
            <span class="who">{nodeName(e.node_id)}</span>
            <span class={"val" + (e.cleared ? " cleared" : "")} title={fmtVal(e.value)}>
              {e.cleared ? "（清空）" : fmtVal(e.value)}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function openFieldHistory(recId: string, propId: string, propName: string) {
  openModal(<FieldHistoryModal recId={recId} propId={propId} propName={propName} />);
}

// ---- database activity (read-only feed across all records) -------------------

/** Status word for an activity entry; plain edits let the value diffs speak. */
function activityStatus(e: DatabaseActivityEntry): string {
  if (e.deleted) return "已删除";
  if (e.created) return "创建";
  if (e.moved && !e.diffs.length) return "调整排序";
  return "";
}

const ACTIVITY_DIFF_PREVIEW = 3;

/** "What happened in this table lately" — a read-only drawer with inline
 *  old→new value diffs, filterable by record and by device. Titles come from
 *  the server's per-revision snapshot, so deleted records still show their
 *  last title. */
export function DbActivityPanel({ dbId, onClose }: { dbId: string; onClose: () => void }) {
  const { open, close } = useDrawerTransition(onClose);
  const [entries, setEntries] = useState<DatabaseActivityEntry[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filterRec, setFilterRec] = useState<string | null>(null);
  const [filterNode, setFilterNode] = useState<string | null>(null);
  const nodeName = useNodeNames();

  useEffect(() => {
    Promise.all([api.databaseActivity(dbId), api.listProperties(dbId)])
      .then(([acts, props]) => {
        setEntries(acts);
        setNames(new Map(props.map((p) => [p.id, p.name])));
      })
      .catch((e) => toast(String((e as Error).message)));
  }, [dbId]);

  // Filter options come from the loaded feed itself — no extra requests. The
  // feed is newest-first, so the first title seen per record is its latest.
  const recOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries ?? [])
      if (!m.has(e.record_id)) m.set(e.record_id, e.record_title || e.record_id);
    return [...m];
  }, [entries]);
  const nodeOptions = useMemo(
    () => [...new Set((entries ?? []).map((e) => e.node_id))],
    [entries],
  );

  const visible = (entries ?? []).filter(
    (e) =>
      (showAll || e.kind !== "repair") &&
      (filterRec == null || e.record_id === filterRec) &&
      (filterNode == null || e.node_id === filterNode),
  );

  return (
    <>
      <div class={"scrim" + (open ? " open" : "")} onClick={close} />
      <div class={"peek" + (open ? " open" : "")}>
        <div class="peek-head">
          <button class="iconbtn" onClick={close}>
            <Icon name="x" />
          </button>
          <span class="hist-title">
            <Icon name="history" cls="ico sm" />
            最近动态
          </span>
          <div style={{ flex: 1 }} />
          <label class="hist-toggle">
            <input type="checkbox" checked={showAll} onInput={() => setShowAll(!showAll)} />
            显示修复
          </label>
        </div>
        <div class="hist-filters">
          <select
            value={filterRec ?? ""}
            onChange={(e) => setFilterRec((e.target as HTMLSelectElement).value || null)}
          >
            <option value="">全部记录</option>
            {recOptions.map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
          <select
            value={filterNode ?? ""}
            onChange={(e) => setFilterNode((e.target as HTMLSelectElement).value || null)}
          >
            <option value="">全部设备</option>
            {nodeOptions.map((id) => (
              <option key={id} value={id}>
                {nodeName(id)}
              </option>
            ))}
          </select>
          {(filterRec != null || filterNode != null) && (
            <button
              class="hist-clear"
              onClick={() => {
                setFilterRec(null);
                setFilterNode(null);
              }}
            >
              清除筛选
            </button>
          )}
        </div>
        <div class="peek-body hist-feed">
          {entries === null && <div class="muted pad">加载中…</div>}
          {entries !== null && visible.length === 0 && <div class="muted pad">暂无动态。</div>}
          {visible.map((e) => {
            const key = e.record_id + e.version;
            const all = expanded.has(key);
            const diffs = all ? e.diffs : e.diffs.slice(0, ACTIVITY_DIFF_PREVIEW);
            const status = activityStatus(e);
            return (
              <div key={key} class="hist-item static">
                <div class="row1">
                  <span class="when" title={new Date(e.at).toLocaleString()}>
                    {timeAgo(e.at)}
                  </span>
                  <KindBadge kind={e.kind} />
                  <button
                    class="hist-recname"
                    title="只看这条记录"
                    onClick={() => setFilterRec(e.record_id)}
                  >
                    {e.record_title || e.record_id}
                  </button>
                  {status && <span class="hist-status">{status}</span>}
                </div>
                <div class="row2">
                  <span class="who">{nodeName(e.node_id)}</span>
                </div>
                {diffs.length > 0 && (
                  <div class="hist-fields">
                    {diffs.map((d) => (
                      <div key={d.prop} class="hist-field">
                        <span class="fname">{names.get(d.prop) ?? "（已删字段）"}</span>
                        {!e.created && (
                          <span class="old" title={fmtVal(d.before)}>
                            {fmtVal(d.before)}
                          </span>
                        )}
                        {!e.created && <span class="arr">→</span>}
                        <span class="new" title={fmtVal(d.after)}>
                          {fmtVal(d.after)}
                        </span>
                      </div>
                    ))}
                    {e.diffs.length > ACTIVITY_DIFF_PREVIEW && !all && (
                      <button
                        class="hist-more"
                        onClick={() => setExpanded(new Set(expanded).add(key))}
                      >
                        …还有 {e.diffs.length - ACTIVITY_DIFF_PREVIEW} 项
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
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
                        <button
                          class="fname link"
                          title="查看此字段完整历史"
                          onClick={() => openFieldHistory(rec.id, f, names.get(f) ?? "（已删字段）")}
                        >
                          {names.get(f) ?? "（已删字段）"}
                        </button>
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
