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
import { SkelLines } from "./skeleton.tsx";
import { timeAgo } from "./date.ts";
import { t } from "./i18n/t.ts";
import { fmtDate } from "./i18n/fmt.ts";
import {
  closeModal,
  confirmDialog,
  Modal,
  openModal,
  toast,
  useDrawerResize,
  useDrawerTransition,
} from "./ui.tsx";
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
      .catch((e) => {
        setEntries([]);
        toast(String((e as Error).message), { tone: "error" });
      });
  }, [recId, propId]);
  return (
    <Modal
      title={t("「{name}」字段历史", { name: propName })}
      sub={t("该单元格的每一次写入，最新在前。")}
      width={460}
      footer={
        <button class="btn btn-secondary" onClick={closeModal}>
          {t("关闭")}
        </button>
      }
    >
      <div class="hist-fh">
        {entries === null && <SkelLines n={4} cls="pad" />}
        {entries !== null && entries.length === 0 && <div class="muted pad">{t("暂无写入记录。")}</div>}
        {(entries ?? []).map((e) => (
          <div key={e.version} class="hist-fh-row">
            <span class="when" title={fmtDate(e.at, "dateTime")}>
              {timeAgo(e.at)}
            </span>
            <span class="who">{nodeName(e.node_id)}</span>
            <span class={"val" + (e.cleared ? " cleared" : "")} title={fmtVal(e.value)}>
              {e.cleared ? t("（清空）") : fmtVal(e.value)}
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
  if (e.deleted) return t("已删除");
  if (e.created) return t("创建");
  if (e.moved && !e.diffs.length) return t("调整排序");
  return "";
}

const ACTIVITY_DIFF_PREVIEW = 3;

/** "What happened in this table lately" — a read-only drawer with inline
 *  old→new value diffs, filterable by record and by device. Titles come from
 *  the server's per-revision snapshot, so deleted records still show their
 *  last title. */
export function DbActivityPanel({ dbId, onClose }: { dbId: string; onClose: () => void }) {
  const { open, close } = useDrawerTransition(onClose);
  const { width, handle } = useDrawerResize("mh.peekW");
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
      .catch((e) => {
        setEntries([]);
        toast(String((e as Error).message), { tone: "error" });
      });
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
      <div
        class={"peek" + (open ? " open" : "")}
        style={width != null ? { width: `${width}px` } : undefined}
      >
        {handle}
        <div class="peek-head">
          <button class="iconbtn" onClick={close}>
            <Icon name="x" />
          </button>
          <span class="hist-title">
            <Icon name="history" cls="ico sm" />
            {t("最近动态")}
          </span>
          <div style={{ flex: 1 }} />
          <label class="hist-toggle">
            <input type="checkbox" checked={showAll} onInput={() => setShowAll(!showAll)} />
            {t("显示修复")}
          </label>
        </div>
        <div class="hist-filters">
          <select
            value={filterRec ?? ""}
            onChange={(e) => setFilterRec((e.target as HTMLSelectElement).value || null)}
          >
            <option value="">{t("全部记录")}</option>
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
            <option value="">{t("全部设备")}</option>
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
              {t("清除筛选")}
            </button>
          )}
        </div>
        <div class="peek-body hist-feed">
          {entries === null && <SkelLines n={4} cls="pad" />}
          {entries !== null && visible.length === 0 && (
            <div class="muted pad">{filterRec != null || filterNode != null ? t("没有符合筛选的动态。") : t("暂无动态。")}</div>
          )}
          {visible.map((e) => {
            const key = e.record_id + e.version;
            const all = expanded.has(key);
            const diffs = all ? e.diffs : e.diffs.slice(0, ACTIVITY_DIFF_PREVIEW);
            const status = activityStatus(e);
            return (
              <div key={key} class="hist-item static">
                <div class="row1">
                  <span class="when" title={fmtDate(e.at, "dateTime")}>
                    {timeAgo(e.at)}
                  </span>
                  <KindBadge kind={e.kind} />
                  <button
                    class="hist-recname"
                    title={t("只看这条记录")}
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
                        <span class="fname">{names.get(d.prop) ?? t("（已删字段）")}</span>
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
                        {t("…还有 {n} 项", { n: e.diffs.length - ACTIVITY_DIFF_PREVIEW })}
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
  if (r.created) parts.push(t("创建"));
  if (r.deleted) parts.push(t("删除"));
  if (r.fields.length)
    parts.push(r.fields.map((f) => names.get(f) ?? t("（已删字段）")).join(t("、")));
  if (r.moved && !parts.length) parts.push(t("排序"));
  return parts.join(t("；")) || t("元数据");
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
      title: t("恢复到此版本？"),
      message: t("记录字段将恢复到该修订时的值。此操作会作为一次新修订记录。"),
      confirmLabel: t("恢复"),
    });
    if (!ok) return;
    try {
      await api.revertRecord(rec.id, r.version);
      toast(t("已恢复"));
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
          {t("修改历史")}
        </span>
        <label class="hist-toggle">
          <input type="checkbox" checked={showAll} onInput={() => setShowAll(!showAll)} />
          {t("显示修复")}
        </label>
      </div>
      {revs === null && <SkelLines n={4} cls="pad" />}
      {revs !== null && visible.length === 0 && <div class="muted pad">{t("暂无历史。")}</div>}
      {visible.map((r, i) => {
        const prev = visible[i + 1];
        const curState = states.current.get(r.version);
        const prevState = prev ? states.current.get(prev.version) : undefined;
        const fields = r.created && curState ? Object.keys(curState.data) : r.fields;
        return (
          <div key={r.version} class="hist-item static">
            <div class="row1" onClick={() => expand(r, prev)}>
              <span class="when" title={fmtDate(r.at, "dateTime")}>
                {timeAgo(r.at)}
              </span>
              <KindBadge kind={r.kind} />
              {i === 0 && <span class="hist-now">{t("当前")}</span>}
              <div style={{ flex: 1 }} />
              <Icon name={expanded === r.version ? "chevronDown" : "chevron"} cls="ico sm" />
            </div>
            <div class="row2" onClick={() => expand(r, prev)}>
              <span class="who">{nodeName(r.node_id)}</span>
              <span class="what">{recSummary(r, names)}</span>
            </div>
            {expanded === r.version && (
              <div class="hist-fields">
                {!curState && <SkelLines n={2} />}
                {curState &&
                  fields.map((f) => {
                    const before = prevState ? prevState.data[f] : undefined;
                    const after = curState.data[f];
                    return (
                      <div key={f} class="hist-field">
                        <button
                          class="fname link"
                          title={t("查看此字段完整历史")}
                          onClick={() => openFieldHistory(rec.id, f, names.get(f) ?? t("（已删字段）"))}
                        >
                          {names.get(f) ?? t("（已删字段）")}
                        </button>
                        {prev && <span class="old">{fmtVal(before)}</span>}
                        {prev && <span class="arr">→</span>}
                        <span class="new">{fmtVal(after)}</span>
                      </div>
                    );
                  })}
                {curState && i !== 0 && (
                  <button class="btn btn-secondary hist-restore" onClick={() => restore(r)}>
                    {t("恢复到此版本")}
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
