/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import {
  api,
  TYPE_META,
  type Db,
  type Prop,
  type Rec,
  type PropType,
  type PropConfig,
} from "./api.ts";
import { Icon, TYPE_ICON } from "./icons.tsx";
import {
  openMenu,
  closeMenu,
  MenuItem,
  MenuLabel,
  MenuSep,
  confirmDialog,
} from "./ui.tsx";

// ---- option colors (stable per string) ----
const HUES = [4, 28, 45, 130, 165, 200, 220, 255, 290, 330];
function optColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${HUES[h % HUES.length]} 65% 45%)`;
}
function Chip({ text }: { text: string }) {
  return <span class="chip" style={{ ["--c" as any]: optColor(text) }}>{text}</span>;
}

const VIEW_TABS: [string, string][] = [["表格", "list"], ["看板", "group"], ["日历", "calendar"]];
type DropWhere = "before" | "after";

interface RowDragState {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  active: boolean;
  source: HTMLElement;
  ghost: HTMLElement | null;
  targetId: string | null;
  where: DropWhere;
}

interface ColDragState {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  active: boolean;
  source: HTMLElement;
  ghost: HTMLElement | null;
  targetId: string | null;
  where: DropWhere;
}

export function DatabaseView({
  db,
  reloadNav,
  onError,
}: {
  db: Db;
  reloadNav: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [props, setProps] = useState<Prop[]>([]);
  const [records, setRecords] = useState<Rec[]>([]);
  const [tab, setTab] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ name: string; desc: boolean } | null>(null);
  const [editing, setEditing] = useState<{ rec: string; prop: string } | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const rowDragRef = useRef<RowDragState | null>(null);
  const colDragRef = useRef<ColDragState | null>(null);
  const suppressColClick = useRef(false);

  const guard = (fn: () => Promise<void>) => fn().catch((e) => onError(String(e.message)));

  const reload = async () => {
    const [p, r] = await Promise.all([api.listProperties(db.id), api.listRecords(db.id)]);
    setProps(p);
    setRecords(r);
  };
  useEffect(() => {
    setSel(new Set());
    setPeek(null);
    setTab(0);
    reload().catch((e) => onError(String(e.message)));
  }, [db.id]);

  const commit = (rec: Rec, prop: Prop, value: unknown) =>
    guard(async () => {
      const updated = await api.updateRecord(rec.id, { [prop.name]: value });
      setRecords((rs) => rs.map((r) => (r.id === rec.id ? updated : r)));
      setEditing(null);
    });

  const newRecord = () =>
    guard(async () => {
      const rec = await api.createRecord(db.id, {});
      setRecords((rs) => [...rs, rec]);
    });

  const deleteRecords = (ids: string[]) =>
    guard(async () => {
      await Promise.all(ids.map((id) => api.deleteRecord(id)));
      setRecords((rs) => rs.filter((r) => !ids.includes(r.id)));
      setSel(new Set());
      if (peek && ids.includes(peek)) setPeek(null);
    });

  const duplicateRecord = (rec: Rec) =>
    guard(async () => {
      const copy = await api.createRecord(db.id, rec.values);
      setRecords((rs) => {
        const i = rs.findIndex((r) => r.id === rec.id);
        return [...rs.slice(0, i + 1), copy, ...rs.slice(i + 1)];
      });
    });

  const moveRecordLocal = (srcId: string, targetId: string, where: DropWhere) => {
    if (srcId === targetId || sort) return;
    setRecords((rs) => reorderById(rs, srcId, targetId, where));
  };

  const persistRecordMove = (srcId: string, targetId: string, where: DropWhere) => {
    if (srcId === targetId || sort) return;
    moveRecordLocal(srcId, targetId, where);
    api.moveRecord(srcId, targetId, where).catch((e) => {
      onError(String(e.message));
      reload().catch((err) => onError(String(err.message)));
    });
  };

  const persistColumnMove = (srcId: string, targetId: string, where: DropWhere) => {
    if (srcId === targetId) return;
    setProps((cur) => {
      const ordered = reorderById(cur, srcId, targetId, where).map((p, i) => ({ ...p, position: i + 1 }));
      const prev = new Map(cur.map((p) => [p.id, p.position]));
      const changed = ordered.filter((p) => prev.get(p.id) !== p.position);
      if (changed.length) {
        Promise.all(changed.map((p) => api.updateProperty(p.id, { position: p.position }))).catch((e) => {
          onError(String(e.message));
          reload().catch((err) => onError(String(err.message)));
        });
      }
      return ordered;
    });
  };

  const startRowDrag = (e: any, rec: Rec) => {
    if (sort || e.button !== 0) return;
    const source = (e.currentTarget as HTMLElement).closest("tr") as HTMLElement | null;
    if (!source) return;
    e.preventDefault();
    const rect = source.getBoundingClientRect();
    const state: RowDragState = {
      id: rec.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      active: false,
      source,
      ghost: null,
      targetId: null,
      where: "before",
    };
    rowDragRef.current = state;

    const move = (ev: PointerEvent) => {
      const d = rowDragRef.current;
      if (!d || d.pointerId !== ev.pointerId) return;
      if (!d.active) {
        const dx = ev.clientX - d.startX;
        const dy = ev.clientY - d.startY;
        if (Math.hypot(dx, dy) < 4) return;
        d.active = true;
        d.ghost = createRowGhost(d.source);
        d.source.classList.add("drag-source");
        document.body.classList.add("table-dragging");
      }
      ev.preventDefault();
      positionGhost(d.ghost, ev.clientX - d.offsetX, ev.clientY - d.offsetY);
      updateRowDrop(d, ev.clientX, ev.clientY);
    };
    const up = (ev: PointerEvent) => {
      const d = rowDragRef.current;
      if (!d || d.pointerId !== ev.pointerId) return;
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      d.ghost?.remove();
      d.source.classList.remove("drag-source");
      document.body.classList.remove("table-dragging");
      clearRowDrop();
      rowDragRef.current = null;
      if (d.active && d.targetId) persistRecordMove(d.id, d.targetId, d.where);
    };
    addEventListener("pointermove", move, { passive: false });
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  const startColDrag = (e: any, prop: Prop) => {
    if (e.button !== 0) return;
    const source = (e.currentTarget as HTMLElement).closest("th") as HTMLElement | null;
    if (!source) return;
    const rect = source.getBoundingClientRect();
    const state: ColDragState = {
      id: prop.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      active: false,
      source,
      ghost: null,
      targetId: null,
      where: "before",
    };
    colDragRef.current = state;

    const move = (ev: PointerEvent) => {
      const d = colDragRef.current;
      if (!d || d.pointerId !== ev.pointerId) return;
      if (!d.active) {
        const dx = ev.clientX - d.startX;
        const dy = ev.clientY - d.startY;
        if (Math.hypot(dx, dy) < 4) return;
        d.active = true;
        suppressColClick.current = true;
        d.ghost = createColGhost(d.source);
        d.source.classList.add("drag-source");
        document.body.classList.add("table-dragging");
      }
      ev.preventDefault();
      positionGhost(d.ghost, ev.clientX - d.offsetX, ev.clientY - d.offsetY);
      updateColDrop(d, ev.clientX, ev.clientY);
    };
    const up = (ev: PointerEvent) => {
      const d = colDragRef.current;
      if (!d || d.pointerId !== ev.pointerId) return;
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      d.ghost?.remove();
      d.source.classList.remove("drag-source");
      document.body.classList.remove("table-dragging");
      clearColDrop();
      colDragRef.current = null;
      if (d.active) setTimeout(() => { suppressColClick.current = false; }, 0);
      if (d.active && d.targetId) persistColumnMove(d.id, d.targetId, d.where);
    };
    addEventListener("pointermove", move, { passive: false });
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  const sorted = sort
    ? [...records].sort((a, b) => {
        const av = String(a.values[sort.name] ?? "");
        const bv = String(b.values[sort.name] ?? "");
        return (sort.desc ? -1 : 1) * av.localeCompare(bv, "zh");
      })
    : records;

  const peekRec = records.find((r) => r.id === peek) ?? null;

  return (
    <div class="db">
      <div class="db-head">
        <div class="db-icon">{db.icon || "🗂️"}</div>
        <div>
          <div
            class="db-title"
            contentEditable
            onBlur={(e) => {
              const name = (e.target as HTMLElement).textContent?.trim() || db.name;
              if (name !== db.name) guard(async () => { await api.updateDatabase(db.id, { name }); await reloadNav(); });
            }}
          >
            {db.name}
          </div>
        </div>
      </div>

      <div class="views">
        {VIEW_TABS.map(([t, ic], i) => (
          <div key={t} class={"view-tab" + (i === tab ? " active" : "")} onClick={() => setTab(i)}>
            <Icon name={ic} />
            {t}
          </div>
        ))}
        <div class="view-tab" title="新建视图"><Icon name="plus" cls="ico sm" /></div>
      </div>

      <div class="toolbar">
        <button class="tbtn" onClick={(e) => openSortMenu(e, props, sort, setSort)}>
          <Icon name="sort" cls="ico sm" />排序
        </button>
        <button class="tbtn"><Icon name="filter" cls="ico sm" />筛选</button>
        <div class="spacer" />
        <button class="btn btn-primary" onClick={newRecord}><Icon name="plus" cls="ico sm" />新建</button>
      </div>

      {tab !== 0 ? (
        <div class="view-placeholder">「{VIEW_TABS[tab]![0]}」视图为后续迭代（同一数据的另一种呈现）。</div>
      ) : (
        <div class="tablewrap">
          <div class="tablescroll">
            <table class="grid">
              <thead>
                <tr>
                  <th class="selcell">
                    <input
                      type="checkbox"
                      checked={sel.size > 0 && sel.size === records.length}
                      onChange={(e) =>
                        setSel((e.target as HTMLInputElement).checked ? new Set(records.map((r) => r.id)) : new Set())
                      }
                    />
                  </th>
                  <th class="gripcol" />
                  {props.map((p) => (
                    <th key={p.id} data-col-id={p.id} style={{ minWidth: widths[p.id] ?? 180 }}>
                      <div
                        class="colhead"
                        onPointerDown={(e) => startColDrag(e, p)}
                        onClick={(e) => {
                          if (suppressColClick.current) {
                            suppressColClick.current = false;
                            e.preventDefault();
                            e.stopPropagation();
                            return;
                          }
                          openColMenu(e, p, db.id, reload, props);
                        }}
                      >
                        <span class="ti"><Icon name={TYPE_ICON[p.type] ?? "text"} cls="ico sm" /></span>
                        <span class="nm">{p.name}</span>
                      </div>
                      <ColResizer onResize={(w) => setWidths((m) => ({ ...m, [p.id]: w }))} startWidth={widths[p.id] ?? 180} />
                    </th>
                  ))}
                  <th class="addcol">
                    <div class="colhead" title="新建属性" onClick={(e) => openAddCol(e, db.id, reload)}>
                      <Icon name="plus" cls="ico sm" />
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((rec) => (
                  <tr
                    key={rec.id}
                    data-row-id={rec.id}
                    class={sel.has(rec.id) ? "sel" : ""}
                  >
                    <td class="selcell">
                      <input
                        type="checkbox"
                        checked={sel.has(rec.id)}
                        onChange={() =>
                          setSel((s) => { const n = new Set(s); n.has(rec.id) ? n.delete(rec.id) : n.add(rec.id); return n; })
                        }
                      />
                    </td>
                    <td
                      class="rowgrip"
                      title={sort ? "清除排序后可拖拽移动" : "拖拽移动"}
                      aria-disabled={sort ? "true" : undefined}
                      onPointerDown={(e) => startRowDrag(e, rec)}
                    >
                      <Icon name="grip" cls="ico sm" />
                    </td>
                    {props.map((p, ci) => (
                      <td key={p.id} class="cell-td">
                        <CellView
                          rec={rec}
                          prop={p}
                          first={ci === 0}
                          editing={editing?.rec === rec.id && editing?.prop === p.id}
                          onEdit={() => setEditing({ rec: rec.id, prop: p.id })}
                          onCancel={() => setEditing(null)}
                          onCommit={(v) => commit(rec, p, v)}
                          onOpen={() => setPeek(rec.id)}
                          onRowMenu={(e) => openRowMenu(e, rec, () => setPeek(rec.id), () => duplicateRecord(rec), () => deleteRecords([rec.id]))}
                        />
                      </td>
                    ))}
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class="addrow" onClick={newRecord}><Icon name="plus" cls="ico sm" />新建记录</div>
        </div>
      )}

      <div class="gridfoot">
        <span>共 {records.length} 条记录</span>
        <span>{props.length} 个属性</span>
      </div>

      {sel.size > 0 && (
        <div class="selbar">
          <span class="cnt">{sel.size} 已选</span>
          <button onClick={() => guard(async () => { for (const id of sel) await duplicateRecord(records.find((r) => r.id === id)!); })}>
            <Icon name="copy" cls="ico sm" />复制
          </button>
          <button class="del" onClick={async () => {
            const ok = await confirmDialog({ title: "删除记录？", message: `确定删除选中的 ${sel.size} 条记录？`, confirmLabel: "删除", danger: true });
            if (ok) deleteRecords([...sel]);
          }}>
            <Icon name="trash" cls="ico sm" />删除
          </button>
          <button onClick={() => setSel(new Set())}><Icon name="x" cls="ico sm" /></button>
        </div>
      )}

      {peekRec && (
        <RecordPeek
          db={db}
          props={props}
          rec={peekRec}
          onClose={() => setPeek(null)}
          onCommit={(p, v) => commit(peekRec, p, v)}
          onDelete={() => deleteRecords([peekRec.id])}
          onDuplicate={() => duplicateRecord(peekRec)}
        />
      )}
    </div>
  );
}

// ---- cell ----
function CellView({
  rec, prop, first, editing, onEdit, onCancel, onCommit, onOpen, onRowMenu,
}: {
  rec: Rec; prop: Prop; first: boolean; editing: boolean;
  onEdit: () => void; onCancel: () => void; onCommit: (v: unknown) => void;
  onOpen: () => void; onRowMenu: (e: MouseEvent) => void;
}) {
  const val = rec.values[prop.name];

  if (prop.type === "checkbox") {
    return (
      <div class="cell center">
        <input type="checkbox" checked={!!val} style={{ width: 16, height: 16, accentColor: "var(--accent)" }} onChange={() => onCommit(!val)} />
      </div>
    );
  }

  if (editing && (prop.type === "select" || prop.type === "multi_select")) {
    // handled by menu opened on click; fall through to display
  }

  if (editing && prop.type !== "select" && prop.type !== "multi_select") {
    const initial = Array.isArray(val) ? (val as string[]).join(", ") : val == null ? "" : String(val);
    return (
      <div class="cell">
        <input
          class="inlineedit"
          type={prop.type === "number" ? "number" : prop.type === "date" ? "date" : "text"}
          value={initial}
          autofocus
          onBlur={(e) => onCommit(coerceInput(prop.type, (e.target as HTMLInputElement).value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") onCancel();
          }}
        />
      </div>
    );
  }

  const onClick = (e: MouseEvent) => {
    if (prop.type === "select" || prop.type === "multi_select") openSelectMenu(e, prop, val, onCommit);
    else onEdit();
  };

  const body = <CellDisplay prop={prop} val={val} />;
  if (first) {
    return (
      <div class="cell" onClick={onClick}>
        <div class="firstcell">
          <span style={{ flex: 1 }}>{body}</span>
          <button class="rowopen" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
            <Icon name="cornerUpRight" cls="ico sm" />打开
          </button>
          <button class="rowopen" title="更多" onClick={(e) => { e.stopPropagation(); onRowMenu(e); }}>
            <Icon name="dots" cls="ico sm" />
          </button>
        </div>
      </div>
    );
  }
  return <div class="cell" onClick={onClick}>{body}</div>;
}

function CellDisplay({ prop, val }: { prop: Prop; val: unknown }) {
  if (val == null || val === "" || (Array.isArray(val) && val.length === 0))
    return <span class="muted">&nbsp;</span>;
  if (prop.type === "select") return <Chip text={String(val)} />;
  if (prop.type === "multi_select" || prop.type === "relation")
    return <>{(val as unknown[]).map((x) => <Chip key={String(x)} text={String(x)} />)}</>;
  if (prop.type === "url")
    return <a href={String(val)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{String(val)}</a>;
  return <span>{String(val)}</span>;
}

function coerceInput(type: PropType, raw: string): unknown {
  if (type === "relation") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return raw;
}

function reorderById<T extends { id: string }>(items: T[], srcId: string, targetId: string, where: DropWhere): T[] {
  const next = [...items];
  const from = next.findIndex((r) => r.id === srcId);
  if (from < 0) return items;
  const moved = next.splice(from, 1)[0]!;
  let to = next.findIndex((r) => r.id === targetId);
  if (to < 0) return items;
  if (where === "after") to += 1;
  next.splice(to, 0, moved);
  return next;
}

function clearRowDrop() {
  document.querySelectorAll("table.grid tr.drop-before,table.grid tr.drop-after")
    .forEach((n) => n.classList.remove("drop-before", "drop-after"));
}

function markRowDrop(el: HTMLElement, clientY: number): DropWhere {
  clearRowDrop();
  const r = el.getBoundingClientRect();
  const where = clientY < r.top + r.height / 2 ? "before" : "after";
  el.classList.add(where === "before" ? "drop-before" : "drop-after");
  return where;
}

function clearColDrop() {
  document.querySelectorAll("table.grid th.drop-before,table.grid th.drop-after")
    .forEach((n) => n.classList.remove("drop-before", "drop-after"));
}

function markColDrop(el: HTMLElement, clientX: number): DropWhere {
  clearColDrop();
  const r = el.getBoundingClientRect();
  const where = clientX < r.left + r.width / 2 ? "before" : "after";
  el.classList.add(where === "before" ? "drop-before" : "drop-after");
  return where;
}

function updateRowDrop(d: RowDragState, clientX: number, clientY: number) {
  const el = document.elementFromPoint(clientX, clientY)?.closest?.("tr[data-row-id]") as HTMLElement | null;
  if (!el || el.dataset.rowId === d.id) {
    clearRowDrop();
    d.targetId = null;
    return;
  }
  d.targetId = el.dataset.rowId ?? null;
  d.where = markRowDrop(el, clientY);
}

function updateColDrop(d: ColDragState, clientX: number, clientY: number) {
  const el = document.elementFromPoint(clientX, clientY)?.closest?.("th[data-col-id]") as HTMLElement | null;
  if (!el || el.dataset.colId === d.id) {
    clearColDrop();
    d.targetId = null;
    return;
  }
  d.targetId = el.dataset.colId ?? null;
  d.where = markColDrop(el, clientX);
}

function positionGhost(el: HTMLElement | null, left: number, top: number) {
  if (!el) return;
  el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

function createRowGhost(row: HTMLElement): HTMLElement {
  const rect = row.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost row-ghost";
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  const text = Array.from(row.querySelectorAll("td"))
    .map((td) => (td.textContent ?? "").trim())
    .filter(Boolean)
    .join("    ");
  ghost.textContent = text || "移动记录";
  document.body.appendChild(ghost);
  return ghost;
}

function createColGhost(th: HTMLElement): HTMLElement {
  const rect = th.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost col-ghost";
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.textContent = th.textContent?.trim() || "移动属性";
  document.body.appendChild(ghost);
  return ghost;
}

// ---- column resizer ----
function ColResizer({ onResize, startWidth }: { onResize: (w: number) => void; startWidth: number }) {
  const start = (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const move = (ev: PointerEvent) => onResize(Math.max(80, startWidth + ev.clientX - x0));
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up); };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };
  return <div class="col-resizer" onPointerDown={start} />;
}

// ---- select / multi-select editor menu ----
function openSelectMenu(e: MouseEvent, prop: Prop, val: unknown, onCommit: (v: unknown) => void) {
  e.stopPropagation();
  const multi = prop.type === "multi_select";
  const options = prop.config?.options ?? [];
  openMenu(e, (close) => (
    <SelectMenu
      multi={multi}
      options={options}
      value={val}
      onPick={(v) => { onCommit(v); if (!multi) close(); }}
    />
  ));
}
function SelectMenu({ multi, options, value, onPick }: { multi: boolean; options: string[]; value: unknown; onPick: (v: unknown) => void }) {
  const [cur, setCur] = useState<unknown>(value);
  const isOn = (o: string) => (multi ? (Array.isArray(cur) ? cur.includes(o) : false) : cur === o);
  const pick = (o: string) => {
    if (multi) {
      const set = new Set(Array.isArray(cur) ? (cur as string[]) : []);
      set.has(o) ? set.delete(o) : set.add(o);
      const next = [...set];
      setCur(next);
      onPick(next);
    } else {
      setCur(o);
      onPick(o);
    }
  };
  return (
    <>
      <MenuLabel>{multi ? "多选 — 点选切换" : "单选"}</MenuLabel>
      {options.map((o) => (
        <button key={o} class="item" onClick={() => pick(o)}>
          <span class="lico plain"><Chip text={o} /></span>
          {isOn(o) && <span class="chk"><Icon name="check" cls="ico sm" /></span>}
        </button>
      ))}
      {multi && Array.isArray(cur) && cur.length > 0 && (
        <>
          <MenuSep />
          <MenuItem icon="x" label="清空" onClick={() => { setCur([]); onPick([]); }} />
        </>
      )}
    </>
  );
}

// ---- column header menu ----
function openColMenu(e: MouseEvent, prop: Prop, dbId: string, reload: () => Promise<void>, allProps: Prop[]) {
  e.stopPropagation();
  openMenu(e, (close) => <ColMenu prop={prop} dbId={dbId} reload={reload} close={close} allProps={allProps} />, { minWidth: 252 });
}
function ColMenu({ prop, dbId, reload, close, allProps }: { prop: Prop; dbId: string; reload: () => Promise<void>; close: () => void; allProps: Prop[] }) {
  const [name, setName] = useState(prop.name);
  const [type, setType] = useState<PropType>(prop.type);
  const [options, setOptions] = useState<string[]>(prop.config?.options ?? []);

  const persist = (patch: { name?: string; type?: PropType; config?: PropConfig }) =>
    api.updateProperty(prop.id, patch).then(reload).catch(() => {});

  const changeType = (t: PropType) => {
    setType(t);
    let opts = options;
    if ((t === "select" || t === "multi_select") && opts.length === 0) {
      opts = ["选项 1", "选项 2"];
      setOptions(opts);
    }
    persist({ type: t, ...(t === "select" || t === "multi_select" ? { config: { options: opts } } : {}) });
  };
  const setOpts = (next: string[]) => { setOptions(next); persist({ config: { options: next } }); };

  return (
    <>
      <input
        class="field"
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        onBlur={() => name && name !== prop.name && persist({ name })}
        onKeyDown={(e) => { if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); close(); } }}
      />
      <MenuLabel>属性类型</MenuLabel>
      <div class="typegrid">
        {(Object.keys(TYPE_META) as PropType[]).map((t) => (
          <button key={t} class={"item" + (t === type ? " sel" : "")} onClick={() => changeType(t)}>
            <span class="lico"><Icon name={TYPE_ICON[t]!} cls="ico sm" /></span>
            <span class="d">{TYPE_META[t].t}</span>
          </button>
        ))}
      </div>
      {(type === "select" || type === "multi_select") && (
        <>
          <MenuSep />
          <MenuLabel>选项</MenuLabel>
          {options.map((o, i) => (
            <div key={o + i} class="optrow">
              <Chip text={o} />
              <button class="x" onClick={() => setOpts(options.filter((_, j) => j !== i))}><Icon name="x" cls="ico sm" /></button>
            </div>
          ))}
          <MenuItem icon="plus" label="添加选项" onClick={() => setOpts([...options, "选项 " + (options.length + 1)])} />
        </>
      )}
      <MenuSep />
      <MenuItem icon="cornerUpRight" label="在右侧插入列" onClick={() => { close(); api.createProperty({ db: dbId, name: "新属性", type: "text" }).then(reload); }} />
      <MenuSep />
      <MenuItem icon="trash" label="删除属性" danger onClick={async () => {
        close();
        const ok = await confirmDialog({ title: "删除属性？", message: `「${prop.name}」及其所有单元格数据将被移除。`, confirmLabel: "删除", danger: true });
        if (ok) api.deleteProperty(prop.id).then(reload);
      }} />
    </>
  );
}

function openAddCol(e: MouseEvent, dbId: string, reload: () => Promise<void>) {
  e.stopPropagation();
  openMenu(e, (close) => (
    <>
      <MenuLabel>新建属性 · 选择类型</MenuLabel>
      <div class="typegrid">
        {(Object.keys(TYPE_META) as PropType[]).map((t) => (
          <button key={t} class="item" onClick={() => {
            close();
            const cfg = t === "select" || t === "multi_select" ? { options: ["选项 1", "选项 2"] } : undefined;
            api.createProperty({ db: dbId, name: TYPE_META[t].t, type: t, config: cfg }).then(reload).catch(() => {});
          }}>
            <span class="lico"><Icon name={TYPE_ICON[t]!} cls="ico sm" /></span>
            <span class="d">{TYPE_META[t].t}</span>
          </button>
        ))}
      </div>
    </>
  ));
}

function openSortMenu(e: MouseEvent, props: Prop[], cur: { name: string; desc: boolean } | null, setSort: (s: { name: string; desc: boolean } | null) => void) {
  openMenu(e, (close) => (
    <>
      <MenuLabel>排序依据</MenuLabel>
      {props.map((p) => (
        <MenuItem key={p.id} icon={TYPE_ICON[p.type]} label={p.name} onClick={() => { setSort({ name: p.name, desc: cur?.name === p.name ? !cur.desc : false }); close(); }} />
      ))}
      {cur && (<><MenuSep /><MenuItem icon="x" label="清除排序" onClick={() => { setSort(null); close(); }} /></>)}
    </>
  ));
}

function openRowMenu(e: MouseEvent, rec: Rec, onOpen: () => void, onDup: () => void, onDel: () => void) {
  e.stopPropagation();
  openMenu(e, (close) => (
    <>
      <MenuItem icon="cornerUpRight" label="打开记录" onClick={() => { close(); onOpen(); }} />
      <MenuItem icon="copy" label="复制记录" onClick={() => { close(); onDup(); }} />
      <MenuSep />
      <MenuItem icon="trash" label="删除记录" danger onClick={async () => {
        close();
        const ok = await confirmDialog({ title: "删除记录？", message: "确定删除这条记录？", confirmLabel: "删除", danger: true });
        if (ok) onDel();
      }} />
    </>
  ));
}

// ---- record peek panel ----
function RecordPeek({
  db, props, rec, onClose, onCommit, onDelete, onDuplicate,
}: {
  db: Db; props: Prop[]; rec: Rec;
  onClose: () => void; onCommit: (p: Prop, v: unknown) => void; onDelete: () => void; onDuplicate: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const titleProp = props[0];
  return (
    <>
      <div class="scrim open" onClick={onClose} />
      <div class="peek open">
        <div class="peek-head">
          <button class="iconbtn" onClick={onClose}><Icon name="x" /></button>
          <div style={{ flex: 1 }} />
          <button class="iconbtn" title="更多" onClick={(e) =>
            openMenu(e, (close) => (
              <>
                <MenuItem icon="copy" label="复制记录" onClick={() => { close(); onDuplicate(); }} />
                <MenuSep />
                <MenuItem icon="trash" label="删除记录" danger onClick={async () => { close(); const ok = await confirmDialog({ title: "删除记录？", message: "确定删除这条记录？", confirmLabel: "删除", danger: true }); if (ok) onDelete(); }} />
              </>
            ))
          }><Icon name="dots" /></button>
        </div>
        <div class="peek-body">
          <h2 contentEditable onBlur={(e) => titleProp && onCommit(titleProp, (e.target as HTMLElement).textContent ?? "")}>
            {titleProp ? String(rec.values[titleProp.name] ?? "无标题") : "无标题"}
          </h2>
          {props.map((p) => (
            <div key={p.id} class="proprow">
              <div class="k"><Icon name={TYPE_ICON[p.type] ?? "text"} cls="ico sm" /><span>{p.name}</span></div>
              <PeekValue
                prop={p}
                rec={rec}
                editing={editing === p.id}
                onEdit={() => setEditing(p.id)}
                onCommit={(v) => { onCommit(p, v); setEditing(null); }}
              />
            </div>
          ))}
          <div class="peek-divider" />
          <div class="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>页面正文</div>
          <div class="editable" contentEditable data-ph="记录也可拥有自己的块级正文…" style={{ minHeight: 90 }}>
            每条记录都可作为页面打开，并拥有块级正文。
          </div>
        </div>
      </div>
    </>
  );
}

function PeekValue({ prop, rec, editing, onEdit, onCommit }: { prop: Prop; rec: Rec; editing: boolean; onEdit: () => void; onCommit: (v: unknown) => void }) {
  const val = rec.values[prop.name];
  if (prop.type === "checkbox")
    return <div class="v"><input type="checkbox" checked={!!val} style={{ width: 16, height: 16, accentColor: "var(--accent)" }} onChange={() => onCommit(!val)} /></div>;
  if (prop.type === "select" || prop.type === "multi_select")
    return <div class="v" onClick={(e) => openSelectMenu(e as unknown as MouseEvent, prop, val, onCommit)}><CellDisplay prop={prop} val={val} /></div>;
  if (editing) {
    const initial = Array.isArray(val) ? (val as string[]).join(", ") : val == null ? "" : String(val);
    return (
      <div class="v">
        <input
          class="inlineedit"
          type={prop.type === "number" ? "number" : prop.type === "date" ? "date" : "text"}
          value={initial}
          autofocus
          onBlur={(e) => onCommit(coerceInput(prop.type, (e.target as HTMLInputElement).value))}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
      </div>
    );
  }
  return <div class="v" onClick={onEdit}><CellDisplay prop={prop} val={val} /></div>;
}
