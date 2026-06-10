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
  useDrawerTransition,
  toast,
} from "./ui.tsx";
import { Chip, CellDisplay, coerceInput, cellText } from "./cells.tsx";
import { RecordHistoryView } from "./history.tsx";
import { BoardView } from "./board.tsx";
import { CalendarView } from "./calendar.tsx";
import { TimelineView } from "./timeline.tsx";
import {
  type DropWhere,
  startPointerDrag,
  startGhostDrag,
  startColumnResize,
} from "./pointer-drag.ts";

const VIEW_TABS: [string, string][] = [
  ["表格", "list"],
  ["看板", "group"],
  ["日历", "calendar"],
  ["时间轴", "timeline"],
];

// ---- cell range selection ----
type CellPos = { r: number; c: number }; // r = row index in sorted, c = column index in props
type CellSel = { a: CellPos; b: CellPos }; // a = anchor, b = focus
function normRect(s: CellSel) {
  return {
    r0: Math.min(s.a.r, s.b.r), r1: Math.max(s.a.r, s.b.r),
    c0: Math.min(s.a.c, s.b.c), c1: Math.max(s.a.c, s.b.c),
  };
}

export function DatabaseView({
  db,
  onError,
}: {
  db: Db;
  onError: (m: string) => void;
}) {
  const [props, setProps] = useState<Prop[]>([]);
  const [records, setRecords] = useState<Rec[]>([]);
  const [tab, setTab] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ id: string; desc: boolean } | null>(null);
  const [editing, setEditing] = useState<{ rec: string; prop: string } | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const [cellSel, setCellSel] = useState<CellSel | null>(null);
  // Column width lives in prop.config.width (persisted + replicated); 180 is the default.
  const colWidth = (p: Prop) => p.config?.width ?? 180;
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
    setCellSel(null);
    reload().catch((e) => onError(String(e.message)));
  }, [db.id]);

  const commit = (rec: Rec, prop: Prop, value: unknown) =>
    guard(async () => {
      const updated = await api.updateRecord(rec.id, { [prop.id]: value });
      setRecords((rs) => rs.map((r) => (r.id === rec.id ? updated : r)));
      setEditing(null);
    });

  const createRecordWith = (values: Record<string, unknown>) =>
    guard(async () => {
      const rec = await api.createRecord(db.id, values);
      setRecords((rs) => [...rs, rec]);
    });
  const newRecord = () => createRecordWith({});

  const deleteRecords = (ids: string[]) =>
    guard(async () => {
      await Promise.all(ids.map((id) => api.deleteRecord(id)));
      setRecords((rs) => rs.filter((r) => !ids.includes(r.id)));
      setSel(new Set());
      if (peek && ids.includes(peek)) setPeek(null);
    });

  const duplicateRecord = (rec: Rec) =>
    guard(async () => {
      const copy = await api.createRecord(db.id, rec.cells);
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
    startGhostDrag(e, {
      source,
      axis: "y",
      ghostCls: "row-ghost",
      ghostText: rowGhostText(source),
      targetSelector: "tr[data-row-id]",
      isSelf: (el) => el.dataset.rowId === rec.id,
      onDrop: (el, where) => persistRecordMove(rec.id, el.dataset.rowId!, where),
    });
  };

  const startColDrag = (e: any, prop: Prop) => {
    if (e.button !== 0) return;
    const source = (e.currentTarget as HTMLElement).closest("th") as HTMLElement | null;
    if (!source) return;
    startGhostDrag(e, {
      source,
      axis: "x",
      ghostCls: "col-ghost",
      ghostText: source.textContent?.trim() || "移动属性",
      targetSelector: "th[data-col-id]",
      isSelf: (el) => el.dataset.colId === prop.id,
      // Header click opens the column menu; a real drag must swallow the click
      // that fires on release (reset on the next tick, after that click).
      onActivate: () => { suppressColClick.current = true; },
      onDrop: (el, where) => persistColumnMove(prop.id, el.dataset.colId!, where),
      onFinish: (active) => {
        if (active) setTimeout(() => { suppressColClick.current = false; }, 0);
      },
    });
  };

  const startCellSelect = (e: any, ri: number, ci: number) => {
    if (e.button !== 0) return;
    // Let inputs / buttons / links handle their own clicks (checkbox, row-open, edit input, url).
    if ((e.target as HTMLElement).closest("input,button,a")) return;
    const anchor = e.shiftKey && cellSel ? cellSel.a : { r: ri, c: ci };
    setCellSel({ a: anchor, b: { r: ri, c: ci } });
    startPointerDrag(e, {
      onStart: () => document.body.classList.add("cell-selecting"),
      onMove: (ev) => {
        const td = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.("td.cell-td") as HTMLElement | null;
        if (!td || td.dataset.r == null) return;
        setCellSel({ a: anchor, b: { r: Number(td.dataset.r), c: Number(td.dataset.c) } });
      },
      onEnd: () => document.body.classList.remove("cell-selecting"),
    });
  };

  // Apply a value to every cell in the current selection, batching all changed
  // columns per record into a single updateRecord call.
  const applyToSelection = (valueFor: (p: Prop) => unknown) =>
    guard(async () => {
      if (!cellSel) return;
      const { r0, r1, c0, c1 } = normRect(cellSel);
      const cols = props.slice(c0, c1 + 1);
      const rows = sorted.slice(r0, r1 + 1);
      const updates = await Promise.all(rows.map((rec) => {
        const patch: Record<string, unknown> = {};
        for (const p of cols) patch[p.id] = valueFor(p);
        return api.updateRecord(rec.id, patch);
      }));
      setRecords((rs) => rs.map((r) => updates.find((u) => u.id === r.id) ?? r));
    });

  const copySelection = async () => {
    if (!cellSel) return;
    const { r0, r1, c0, c1 } = normRect(cellSel);
    const cols = props.slice(c0, c1 + 1);
    const tsv = sorted.slice(r0, r1 + 1)
      .map((rec) => cols.map((p) => cellText(p, rec.cells[p.id])).join("\t"))
      .join("\n");
    try { await navigator.clipboard.writeText(tsv); } catch { /* clipboard blocked */ }
  };

  // Number columns compare numerically ("9" < "10"); empty/non-numeric cells
  // sort first. Everything else compares as zh-collated text.
  const sortProp = sort ? props.find((p) => p.id === sort.id) : undefined;
  const sortNum = (v: unknown) => {
    const n = v == null || v === "" ? NaN : Number(v);
    return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
  };
  const sorted = sort
    ? [...records].sort((a, b) => {
        const av = a.cells[sort.id];
        const bv = b.cells[sort.id];
        const cmp =
          sortProp?.type === "number"
            ? sortNum(av) - sortNum(bv)
            : String(av ?? "").localeCompare(String(bv ?? ""), "zh");
        return (sort.desc ? -1 : 1) * cmp;
      })
    : records;

  const peekRec = records.find((r) => r.id === peek) ?? null;
  const cr = cellSel ? normRect(cellSel) : null;

  // Keyboard: copy (Cmd/Ctrl+C), clear (Delete/Backspace), dismiss (Escape) on the cell selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!cellSel || editing) return;
      const ae = document.activeElement as HTMLElement | null;
      const tag = (ae?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || ae?.isContentEditable) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") { e.preventDefault(); copySelection(); }
      else if (e.key === "Escape") { setCellSel(null); }
      else if ((e.key === "Delete" || e.key === "Backspace")) {
        const r = normRect(cellSel);
        if (r.r0 !== r.r1 || r.c0 !== r.c1) { e.preventDefault(); applyToSelection(() => null); }
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [cellSel, editing, records, props, sort]);

  return (
    <div
      class="db"
      onPointerDown={(e) => {
        if (!(e.target as HTMLElement).closest("td.cell-td, .cellselbar")) setCellSel(null);
      }}
    >
      <div class="db-head">
        <div class="db-icon">{db.icon || "🗂️"}</div>
        <div>
          <div
            class="db-title"
            contentEditable
            onBlur={(e) => {
              const name = (e.target as HTMLElement).textContent?.trim() || db.name;
              if (name !== db.name) guard(async () => { await api.updateDatabase(db.id, { name }); });
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
        <div class="spacer" style={{ flex: 1 }} />
        <button class="btn btn-primary" onClick={newRecord}><Icon name="plus" cls="ico sm" />新建</button>
      </div>

      {tab === 0 && (
        <div class="toolbar">
          <button class="tbtn" onClick={(e) => openSortMenu(e, props, sort, setSort)}>
            <Icon name="sort" cls="ico sm" />排序
          </button>
        </div>
      )}

      {tab === 1 ? (
        <BoardView
          props={props}
          records={records}
          onCommitValue={commit}
          onCreate={createRecordWith}
          onOpenRecord={setPeek}
          onMove={persistRecordMove}
        />
      ) : tab === 2 ? (
        <CalendarView
          props={props}
          records={records}
          onCommitValue={commit}
          onCreate={createRecordWith}
          onOpenRecord={setPeek}
        />
      ) : tab === 3 ? (
        <TimelineView
          props={props}
          records={records}
          onCommitValue={commit}
          onCreate={createRecordWith}
          onOpenRecord={setPeek}
        />
      ) : (
        <div class="tablewrap">
          <div class="tablescroll">
            <table class="grid">
              <colgroup>
                <col style={{ width: 38 }} />
                <col style={{ width: 26 }} />
                {props.map((p) => (
                  <col key={p.id} data-col-id={p.id} style={{ width: colWidth(p) }} />
                ))}
                <col />
              </colgroup>
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
                    <th key={p.id} data-col-id={p.id}>
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
                      <ColResizer
                        colId={p.id}
                        startWidth={colWidth(p)}
                        onCommit={(w) => {
                          setProps((ps) => ps.map((x) => (x.id === p.id ? { ...x, config: { ...(x.config ?? {}), width: w } } : x)));
                          api.setColumnWidth(p.id, w).catch((e) => { onError(String(e.message)); reload().catch(() => {}); });
                        }}
                      />
                    </th>
                  ))}
                  <th class="addcol">
                    <div class="colhead" title="新建属性" onClick={(e) => openAddCol(e, db.id, props, reload)}>
                      <Icon name="plus" cls="ico sm" />
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((rec, ri) => (
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
                    {props.map((p, ci) => {
                      const inSel = cr != null && ri >= cr.r0 && ri <= cr.r1 && ci >= cr.c0 && ci <= cr.c1;
                      let boxShadow: string | undefined;
                      if (inSel && cr) {
                        const parts: string[] = [];
                        if (ri === cr.r0) parts.push("inset 0 2px 0 0 var(--accent)");
                        if (ri === cr.r1) parts.push("inset 0 -2px 0 0 var(--accent)");
                        if (ci === cr.c0) parts.push("inset 2px 0 0 0 var(--accent)");
                        if (ci === cr.c1) parts.push("inset -2px 0 0 0 var(--accent)");
                        boxShadow = parts.join(",") || undefined;
                      }
                      return (
                        <td
                          key={p.id}
                          class={"cell-td" + (inSel ? " cellsel" : "")}
                          data-r={ri}
                          data-c={ci}
                          style={boxShadow ? { boxShadow } : undefined}
                          onPointerDown={(e) => startCellSelect(e, ri, ci)}
                        >
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
                      );
                    })}
                    <td class="filler" />
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

      {cr && (cr.r0 !== cr.r1 || cr.c0 !== cr.c1) && (
        <div class="selbar cellselbar">
          <span class="cnt">{(cr.r1 - cr.r0 + 1) * (cr.c1 - cr.c0 + 1)} 个单元格</span>
          <button onClick={copySelection}><Icon name="copy" cls="ico sm" />复制</button>
          <button onClick={() => applyToSelection((p) => sorted[cr.r0]!.cells[p.id] ?? null)}>
            <Icon name="copy" cls="ico sm" />填充
          </button>
          <button class="del" onClick={() => applyToSelection(() => null)}>
            <Icon name="trash" cls="ico sm" />清空
          </button>
          <button onClick={() => setCellSel(null)}><Icon name="x" cls="ico sm" /></button>
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
          onReverted={() => reload().catch((e) => onError(String(e.message)))}
        />
      )}
    </div>
  );
}

// ---- cell ----
/** Single-field inline editor for text/number/date/url/relation values:
 *  commits on blur or Enter, cancels on Escape. Shared by the grid cells and
 *  the record peek panel. */
function InlineEditInput({
  prop, val, onCommit, onCancel,
}: {
  prop: Prop; val: unknown; onCommit: (v: unknown) => void; onCancel?: () => void;
}) {
  const initial = Array.isArray(val) ? (val as string[]).join(", ") : val == null ? "" : String(val);
  return (
    <input
      class="inlineedit"
      type={prop.type === "number" ? "number" : prop.type === "date" ? "date" : "text"}
      value={initial}
      autofocus
      onBlur={(e) => onCommit(coerceInput(prop.type, (e.target as HTMLInputElement).value))}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") onCancel?.();
      }}
    />
  );
}

function CellView({
  rec, prop, first, editing, onEdit, onCancel, onCommit, onOpen, onRowMenu,
}: {
  rec: Rec; prop: Prop; first: boolean; editing: boolean;
  onEdit: () => void; onCancel: () => void; onCommit: (v: unknown) => void;
  onOpen: () => void; onRowMenu: (e: MouseEvent) => void;
}) {
  const val = rec.cells[prop.id];

  if (prop.type === "checkbox") {
    return (
      <div class="cell center">
        <input type="checkbox" checked={!!val} style={{ width: 16, height: 16, accentColor: "var(--accent)" }} onChange={() => onCommit(!val)} />
      </div>
    );
  }

  // select / multi_select never enter the editing state — their menu opens on
  // click instead (see onActivate below) — so this branch covers the rest.
  if (editing && prop.type !== "select" && prop.type !== "multi_select") {
    return (
      <div class="cell">
        <InlineEditInput prop={prop} val={val} onCommit={onCommit} onCancel={onCancel} />
      </div>
    );
  }

  // Single click selects the cell (handled by the <td> pointer handler); double click edits.
  const onActivate = (e: MouseEvent) => {
    if (prop.type === "select" || prop.type === "multi_select") openSelectMenu(e, prop, val, onCommit);
    else onEdit();
  };

  const body = <CellDisplay prop={prop} val={val} />;
  if (first) {
    return (
      <div class="cell" onDblClick={onActivate} onContextMenu={(e) => { e.preventDefault(); onRowMenu(e); }}>
        <div class="firstcell">
          {body}
          <div class="rowactions">
            <button class="rowopen" title="打开" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
              <Icon name="openPeek" cls="ico sm" />
            </button>
          </div>
        </div>
      </div>
    );
  }
  return <div class="cell" onDblClick={onActivate}>{body}</div>;
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

function rowGhostText(row: HTMLElement): string {
  const text = Array.from(row.querySelectorAll("td"))
    .map((td) => (td.textContent ?? "").trim())
    .filter(Boolean)
    .join("    ");
  return text || "移动记录";
}

// ---- column resizer ----
function ColResizer({ colId, startWidth, onCommit }: { colId: string; startWidth: number; onCommit: (w: number) => void }) {
  const start = (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    startColumnResize(e, {
      col: document.querySelector<HTMLElement>(`col[data-col-id="${CSS.escape(colId)}"]`),
      startWidth,
      min: 80,
      onDone: onCommit,
    });
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
          <Chip text={o} />
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
    api.updateProperty(prop.id, patch).then(reload).catch((e) => toast(`更新属性失败：${(e as Error).message}`));

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
      <MenuItem icon="cornerUpRight" label="在右侧插入列" onClick={() => {
        close();
        api.createProperty({ db: dbId, name: uniquePropName("新属性", allProps), type: "text" })
          .then(reload)
          .catch((e) => toast(`新建属性失败：${(e as Error).message}`));
      }} />
      <MenuSep />
      <MenuItem icon="trash" label="删除属性" danger onClick={async () => {
        close();
        const ok = await confirmDialog({ title: "删除属性？", message: `「${prop.name}」及其所有单元格数据将被移除。`, confirmLabel: "删除", danger: true });
        if (ok) api.deleteProperty(prop.id).then(reload);
      }} />
    </>
  );
}

/** Default column names come from fixed labels ("日期", "新属性"…); suffix with
 *  a counter so a repeat creation never duplicates an existing name — duplicate
 *  names alias in name-keyed access and are indistinguishable in the UI. */
function uniquePropName(base: string, existing: Prop[]): string {
  const names = new Set(existing.map((p) => p.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const cand = `${base} ${i}`;
    if (!names.has(cand.toLowerCase())) return cand;
  }
}

function openAddCol(e: MouseEvent, dbId: string, allProps: Prop[], reload: () => Promise<void>) {
  e.stopPropagation();
  openMenu(e, (close) => (
    <>
      <MenuLabel>新建属性 · 选择类型</MenuLabel>
      <div class="typegrid">
        {(Object.keys(TYPE_META) as PropType[]).map((t) => (
          <button key={t} class="item" onClick={() => {
            close();
            const cfg = t === "select" || t === "multi_select" ? { options: ["选项 1", "选项 2"] } : undefined;
            api.createProperty({ db: dbId, name: uniquePropName(TYPE_META[t].t, allProps), type: t, config: cfg })
              .then(reload)
              .catch((e) => toast(`新建属性失败：${(e as Error).message}`));
          }}>
            <span class="lico"><Icon name={TYPE_ICON[t]!} cls="ico sm" /></span>
            <span class="d">{TYPE_META[t].t}</span>
          </button>
        ))}
      </div>
    </>
  ));
}

function openSortMenu(e: MouseEvent, props: Prop[], cur: { id: string; desc: boolean } | null, setSort: (s: { id: string; desc: boolean } | null) => void) {
  openMenu(e, (close) => (
    <>
      <MenuLabel>排序依据</MenuLabel>
      {props.map((p) => (
        <MenuItem key={p.id} icon={TYPE_ICON[p.type]} label={p.name} onClick={() => { setSort({ id: p.id, desc: cur?.id === p.id ? !cur.desc : false }); close(); }} />
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
  db, props, rec, onClose, onCommit, onDelete, onDuplicate, onReverted,
}: {
  db: Db; props: Prop[]; rec: Rec;
  onClose: () => void; onCommit: (p: Prop, v: unknown) => void; onDelete: () => void; onDuplicate: () => void;
  onReverted: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [hist, setHist] = useState(false);
  const { open, close } = useDrawerTransition(onClose);
  const titleProp = props[0];
  return (
    <>
      <div class={"scrim" + (open ? " open" : "")} onClick={close} />
      <div class={"peek" + (open ? " open" : "")}>
        <div class="peek-head">
          <button class="iconbtn" onClick={close}><Icon name="x" /></button>
          {hist && (
            <button class="iconbtn" title="返回字段" onClick={() => setHist(false)}>
              <Icon name="arrowLeft" />
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button class="iconbtn" title="更多" onClick={(e) =>
            openMenu(e, (close) => (
              <>
                <MenuItem icon="history" label="版本历史" checked={hist} onClick={() => { close(); setHist(!hist); }} />
                <MenuItem icon="copy" label="复制记录" onClick={() => { close(); onDuplicate(); }} />
                <MenuSep />
                <MenuItem icon="trash" label="删除记录" danger onClick={async () => { close(); const ok = await confirmDialog({ title: "删除记录？", message: "确定删除这条记录？", confirmLabel: "删除", danger: true }); if (ok) onDelete(); }} />
              </>
            ))
          }><Icon name="dots" /></button>
        </div>
        <div class="peek-body">
          {hist ? (
            <RecordHistoryView rec={rec} props={props} onReverted={onReverted} />
          ) : (
            <>
              <h2 contentEditable onBlur={(e) => titleProp && onCommit(titleProp, (e.target as HTMLElement).textContent ?? "")}>
                {titleProp ? String(rec.cells[titleProp.id] ?? "无标题") : "无标题"}
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
            </>
          )}
        </div>
      </div>
    </>
  );
}

function PeekValue({ prop, rec, editing, onEdit, onCommit }: { prop: Prop; rec: Rec; editing: boolean; onEdit: () => void; onCommit: (v: unknown) => void }) {
  const val = rec.cells[prop.id];
  if (prop.type === "checkbox")
    return <div class="v"><input type="checkbox" checked={!!val} style={{ width: 16, height: 16, accentColor: "var(--accent)" }} onChange={() => onCommit(!val)} /></div>;
  if (prop.type === "select" || prop.type === "multi_select")
    return <div class="v" onClick={(e) => openSelectMenu(e as unknown as MouseEvent, prop, val, onCommit)}><CellDisplay prop={prop} val={val} /></div>;
  if (editing) {
    return (
      <div class="v">
        <InlineEditInput prop={prop} val={val} onCommit={onCommit} />
      </div>
    );
  }
  return <div class="v" onClick={onEdit}><CellDisplay prop={prop} val={val} /></div>;
}
