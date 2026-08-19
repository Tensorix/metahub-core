/** @jsxImportSource preact */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
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
import { openShareModal, useSharedTargets } from "./share-modal.tsx";
import {
  openMenu,
  closeMenu,
  MenuItem,
  MenuLabel,
  MenuSep,
  confirmDialog,
  useDrawerResize,
  useDrawerTransition,
  toast,
  type MenuAnchor,
} from "./ui.tsx";
import { SYNCED_EVENT } from "./data/replica.ts";
import { Chip, CellDisplay, coerceInput, cellText, optColor, relationLabel, docLabel } from "./cells.tsx";
import {
  relationTitleList,
  relationTitleProp,
  relationTitleState,
  primeRelationTitle,
  onRelationTitleChange,
} from "./relation-titles.ts";
import { allDocTitles, onDocTitleChange, primeDocTitle } from "./doc-titles.ts";
import { openFieldHistory, RecordHistoryView } from "./history-record.tsx";
import { DocView, type DocViewHandle } from "./editor.tsx";
import { BoardView } from "./board.tsx";
import { CalendarView } from "./calendar.tsx";
import { TimelineView } from "./timeline.tsx";
import {
  type DropWhere,
  startPointerDrag,
  startGhostDrag,
  startColumnResize,
  createDragGhost,
  positionGhost,
} from "./pointer-drag.ts";
import { type CellPos, type CellSel, normRect, edgeShadow } from "./cell-select.ts";
import { plainPasteHandlers } from "./plain-edit.ts";

const VIEW_TABS: [string, string][] = [
  ["表格", "list"],
  ["看板", "group"],
  ["日历", "calendar"],
  ["时间轴", "timeline"],
];

export function DatabaseView({
  db,
  rec,
  onRecNav,
  onError,
}: {
  db: Db;
  /** Record deep link from the hash (#/db/<id>/<rec>); the peek mirrors it. */
  rec: string | null;
  /** Replace-navigate the hash when the peek opens/closes, so a chip click on
   *  the SAME record still fires hashchange next time (same-hash clicks don't). */
  onRecNav: (rec: string | null) => void;
  onError: (m: string) => void;
}) {
  const [props, setProps] = useState<Prop[]>([]);
  const [records, setRecords] = useState<Rec[]>([]);
  const shared = useSharedTargets();
  const [tab, setTab] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ id: string; desc: boolean } | null>(null);
  // seed: type-to-edit's first character — the editor opens with it, replacing the old value.
  const [editing, setEditing] = useState<{ rec: string; prop: string; seed?: string } | null>(null);
  // Mirror for the SYNCED_EVENT handler below (its closure outlives renders).
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [peek, setPeek] = useState<string | null>(null);
  const [cellSel, setCellSel] = useState<CellSel | null>(null);
  // Column width lives in prop.config.width (persisted + replicated); 180 is the default.
  const colWidth = (p: Prop) => p.config?.width ?? 180;
  const suppressColClick = useRef(false);
  // The row drag handle lives *outside* the table card (in the left margin), so it
  // can't be a table cell (clipped by .tablescroll/.tablewrap). A single handle
  // follows the hovered row: `grip` holds its row id + geometry relative to .gridhost.
  const tableRef = useRef<HTMLTableElement>(null);
  const gridHostRef = useRef<HTMLDivElement>(null);
  const [grip, setGrip] = useState<{ id: string; top: number; height: number } | null>(null);
  // Row-reorder drop indicator: a full-width accent line in .gridhost at `dropY`
  // (relative to .gridhost). dropRef mirrors the live target for the pointerup commit.
  const [dropY, setDropY] = useState<number | null>(null);
  const dropRef = useRef<{ id: string; where: DropWhere; y: number } | null>(null);
  // Show the handle for whichever body row the pointer's Y falls into — across the
  // whole .gridhost, so hovering the left gutter/margin (where the handle floats),
  // not just the table cells, summons that row's handle. Header / below-last → hide.
  const trackGripAt = (clientY: number) => {
    if (document.body.classList.contains("table-dragging")) return;
    const host = gridHostRef.current, tbl = tableRef.current;
    if (!host || !tbl) return;
    // fast path: still within the row already shown (one rect read, no re-render)
    const cur = grip && tbl.querySelector<HTMLElement>(`tbody tr[data-row-id="${grip.id}"]`);
    if (cur) {
      const r = cur.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return;
    }
    const hostTop = host.getBoundingClientRect().top;
    for (const tr of Array.from(tbl.querySelectorAll<HTMLElement>("tbody tr[data-row-id]"))) {
      const r = tr.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) {
        setGrip({ id: tr.dataset.rowId!, top: r.top - hostTop, height: r.height });
        return;
      }
    }
    if (grip) setGrip(null);
  };

  const guard = (fn: () => Promise<void>) => fn().catch((e) => onError(String(e.message)));

  const [loaded, setLoaded] = useState(false);
  const reload = async () => {
    const [p, r] = await Promise.all([api.listProperties(db.id), api.listRecords(db.id)]);
    setProps(p);
    setRecords(r);
    setLoaded(true);
  };
  useEffect(() => {
    setSel(new Set());
    setPeek(null);
    setTab(0);
    setCellSel(null);
    setEditing(null);
    reload().catch((e) => onError(String(e.message)));
  }, [db.id]);

  // Peek ⇄ hash. Every internal open/close goes through these two so the hash
  // always mirrors the drawer; the effect below covers the other direction
  // (chip clicks, back/forward). Declared after the db.id reset effect so a
  // deep-linked mount ends with the peek open, not reset.
  const openPeek = (id: string) => { setPeek(id); onRecNav(id); };
  const closePeek = () => { setPeek(null); onRecNav(null); };
  useEffect(() => { setPeek(rec); }, [rec]);
  // Dangling deep link (deleted record / forward reference): explain and clear —
  // a silently dead drawer-less hash would make the chip look broken.
  const recordsRef = useRef(records);
  recordsRef.current = records;
  useEffect(() => {
    if (rec && loaded && !recordsRef.current.some((r) => r.id === rec)) {
      toast("记录不存在或已被删除");
      closePeek();
    }
  }, [rec, loaded]);

  // Local-replica mode: a background sync that touched records/properties may
  // concern this table — re-read from the local store (cheap). Skipped while a
  // cell editor is open so a refresh never eats an in-progress edit.
  useEffect(() => {
    const onSynced = (e: Event) => {
      const detail = (e as CustomEvent).detail as { datasets?: string[] } | undefined;
      if (!detail?.datasets?.some((d) => d === "records" || d === "properties")) return;
      if (editingRef.current) return;
      // Mid-drag (row/card reorder) or mid-rubber-band: replacing records would
      // yank the DOM out from under the pointer. Skip; the drop's own commit
      // reconciles, and external edits surface on the next poke.
      if (
        document.body.classList.contains("table-dragging") ||
        document.body.classList.contains("cell-selecting")
      )
        return;
      reload().catch(() => {});
    };
    document.addEventListener(SYNCED_EVENT, onSynced);
    return () => document.removeEventListener(SYNCED_EVENT, onSynced);
  }, [db.id]);

  // Optimistic: apply locally and exit edit mode synchronously, reconcile with
  // the server response in the background, roll back via reload() on failure.
  const commit = (rec: Rec, prop: Prop, value: unknown) => {
    setEditing(null);
    setRecords((rs) => rs.map((r) =>
      r.id === rec.id
        ? { ...r, cells: { ...r.cells, [prop.id]: value }, values: { ...r.values, [prop.name]: value } }
        : r,
    ));
    api.updateRecord(rec.id, { [prop.id]: value })
      .then((updated) => setRecords((rs) => rs.map((r) => (r.id === updated.id ? updated : r))))
      .catch((e) => {
        onError(String(e.message));
        reload().catch((err) => onError(String(err.message)));
      });
  };

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
      if (peek && ids.includes(peek)) closePeek();
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

  // Resolve the drop target from the pointer's Y alone (the handle is dragged in
  // the left margin, so X-based hit-testing via elementFromPoint can't see a row).
  // Returns the target row + side + the indicator line's y relative to .gridhost.
  const rowDropTarget = (clientY: number, selfId: string): { id: string; where: DropWhere; y: number } | null => {
    const host = gridHostRef.current, tbl = tableRef.current;
    if (!host || !tbl) return null;
    const rows = Array.from(tbl.querySelectorAll<HTMLElement>("tbody tr[data-row-id]"));
    if (!rows.length) return null;
    const hostTop = host.getBoundingClientRect().top;
    let target = rows[rows.length - 1]!, where: DropWhere = "after";
    for (const tr of rows) {
      const r = tr.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { target = tr; where = "before"; break; }
      if (clientY <= r.bottom) { target = tr; where = "after"; break; }
    }
    if (target.dataset.rowId === selfId) return null; // over the source row itself: no-op
    const r = target.getBoundingClientRect();
    return { id: target.dataset.rowId!, where, y: (where === "before" ? r.top : r.bottom) - hostTop };
  };

  const startRowDrag = (e: any, recId: string) => {
    if (sort || e.button !== 0) return;
    // The handle lives outside the table now, so resolve the row from the table itself.
    const source = tableRef.current?.querySelector<HTMLElement>(`tr[data-row-id="${recId}"]`);
    if (!source) return;
    e.preventDefault();
    const rect = source.getBoundingClientRect();
    const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
    let ghost: HTMLElement | null = null;
    startPointerDrag(e, {
      onStart: () => {
        ghost = createDragGhost("row-ghost", rect, rowGhostText(source));
        source.classList.add("drag-source");
        document.body.classList.add("table-dragging");
      },
      onMove: (ev) => {
        positionGhost(ghost, ev.clientX - offX, ev.clientY - offY);
        const t = rowDropTarget(ev.clientY, recId);
        dropRef.current = t;
        setDropY(t ? t.y : null);
      },
      onEnd: (_ev, active) => {
        ghost?.remove();
        source.classList.remove("drag-source");
        document.body.classList.remove("table-dragging");
        const t = dropRef.current;
        dropRef.current = null;
        setDropY(null);
        if (active && t) persistRecordMove(recId, t.id, t.where);
      },
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

  // ---- keyboard cell navigation / editing ----
  // "editable" = the free-text inline editor applies; checkbox toggles in
  // place, select/multi_select/relation/doc edit through their picker popovers.
  const isEditable = (t: PropType) =>
    t !== "checkbox" && t !== "select" && t !== "multi_select" && t !== "relation" && t !== "doc";
  const clampN = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const scrollCellIntoView = (r: number, c: number) =>
    requestAnimationFrame(() => {
      document.querySelector(`td.cell-td[data-r="${r}"][data-c="${c}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  const selectCell = (r: number, c: number) => {
    setCellSel({ a: { r, c }, b: { r, c } });
    scrollCellIntoView(r, c);
  };
  const startEditAt = (r: number, c: number, seed?: string) => {
    const rec = sorted[r];
    const p = props[c];
    if (!rec || !p) return;
    selectCell(r, c);
    // checkbox/select columns: keyboard just selects; their value UI stays click-driven.
    if (isEditable(p.type)) setEditing({ rec: rec.id, prop: p.id, seed });
  };
  const moveEditNeighbor = (r: number, c: number, dc: number) => {
    const nc = c + dc;
    if (nc < 0 || nc >= props.length) { selectCell(r, c); return; }
    startEditAt(r, nc);
  };

  /** Keyboard-opened record picker: anchor the popover at the cell's rect
   *  (there is no MouseEvent to anchor to). */
  const openRelationAt = (r: number, c: number, seed?: string) => {
    const recRow = sorted[r];
    const p = props[c];
    if (!recRow || !p) return;
    selectCell(r, c);
    const td = document.querySelector(`td.cell-td[data-r="${r}"][data-c="${c}"]`);
    const anchor: MenuAnchor = td
      ? { rect: td.getBoundingClientRect() }
      : { x: innerWidth / 2, y: innerHeight / 3 };
    openRelationMenu(anchor, p, recRow.cells[p.id], (v) => commit(recRow, p, v), seed, () => relCreated(p));
  };

  /** Keyboard-opened document picker — same cell-rect anchoring as openRelationAt. */
  const openDocAt = (r: number, c: number, seed?: string) => {
    const recRow = sorted[r];
    const p = props[c];
    if (!recRow || !p) return;
    selectCell(r, c);
    const td = document.querySelector(`td.cell-td[data-r="${r}"][data-c="${c}"]`);
    const anchor: MenuAnchor = td
      ? { rect: td.getBoundingClientRect() }
      : { x: innerWidth / 2, y: innerHeight / 3 };
    openDocMenu(anchor, recRow.cells[p.id], (v) => commit(recRow, p, v), seed);
  };

  /** The picker created a record in prop's target db — a self-relation means
   *  the current table just grew a row it doesn't know about. */
  const relCreated = (p: Prop) => {
    if (p.config?.database === db.id) reload().catch(() => {});
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

  // Keyboard on the cell selection: arrows move (Shift extends), Cmd/Ctrl+C copies,
  // Delete/Backspace clears, Escape dismisses, Enter/F2 edits, and typing a
  // printable character starts editing with it (replacing the old value).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!cellSel || editing) return;
      const ae = document.activeElement as HTMLElement | null;
      const tag = (ae?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || ae?.isContentEditable) return;
      const single = cellSel.a.r === cellSel.b.r && cellSel.a.c === cellSel.b.c;
      const { r, c } = cellSel.b;
      const ARROWS: Record<string, [number, number]> = {
        ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
      };
      if (e.key in ARROWS) {
        e.preventDefault();
        const [dr, dc] = ARROWS[e.key]!;
        const b = { r: clampN(r + dr, 0, sorted.length - 1), c: clampN(c + dc, 0, props.length - 1) };
        setCellSel(e.shiftKey ? { a: cellSel.a, b } : { a: b, b });
        scrollCellIntoView(b.r, b.c);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copySelection();
      } else if (e.key === "Escape") {
        setCellSel(null);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        applyToSelection(() => null);
      } else if (single && (e.key === "Enter" || e.key === "F2")) {
        e.preventDefault();
        if (props[c]?.type === "relation") openRelationAt(r, c);
        else if (props[c]?.type === "doc") openDocAt(r, c);
        else startEditAt(r, c);
      } else if (single && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing && e.keyCode !== 229) {
        // Type-to-edit. Known limit: an IME composition's first key (keyCode 229)
        // can't seed the editor — enter editing via Enter / double-click first.
        const p = props[c];
        if (!p) return;
        if (p.type === "relation") {
          // seed the picker's search instead of the (removed) free-text editor
          e.preventDefault();
          openRelationAt(r, c, e.key);
          return;
        }
        if (p.type === "doc") {
          e.preventDefault();
          openDocAt(r, c, e.key);
          return;
        }
        if (!isEditable(p.type) || p.type === "date") return; // date: Enter/F2 only
        if (p.type === "number" && !/[0-9.+-]/.test(e.key)) return;
        e.preventDefault();
        startEditAt(r, c, e.key);
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
            {...plainPasteHandlers()}
            onBlur={(e) => {
              const name = (e.target as HTMLElement).textContent?.trim() || db.name;
              if (name !== db.name) guard(async () => { await api.updateDatabase(db.id, { name }); });
            }}
          >
            {db.name}
          </div>
        </div>
        {shared.has(db.id) && (
          <span
            class="db-title-share"
            title="已分享 · 管理分享"
            onClick={() => openShareModal({ kind: "database", ref: db.id, title: db.name })}
          >
            <Icon name="link" />
          </span>
        )}
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
          onOpenRecord={openPeek}
          onMove={persistRecordMove}
        />
      ) : tab === 2 ? (
        <CalendarView
          props={props}
          records={records}
          onCommitValue={commit}
          onCreate={createRecordWith}
          onOpenRecord={openPeek}
        />
      ) : tab === 3 ? (
        <TimelineView
          props={props}
          records={records}
          onCommitValue={commit}
          onCreate={createRecordWith}
          onOpenRecord={openPeek}
        />
      ) : (
        <div
          class="gridhost"
          ref={gridHostRef}
          onMouseMove={(e) => trackGripAt(e.clientY)}
          onMouseLeave={() => { if (!document.body.classList.contains("table-dragging")) setGrip(null); }}
        >
          {grip && (
            <button
              class={"rowgrip-ext" + (sort ? " is-disabled" : "")}
              style={{ top: grip.top + grip.height / 2 }}
              title={sort ? "清除排序后可拖拽移动" : "拖拽移动"}
              aria-disabled={sort ? "true" : undefined}
              onPointerDown={(e) => startRowDrag(e, grip.id)}
            >
              <Icon name="grip" cls="ico sm" />
            </button>
          )}
          {dropY != null && <div class="rowdrop" style={{ top: dropY }} />}
          <div class="tablewrap">
          <div class="tablescroll">
            <table class="grid" ref={tableRef}>
              <colgroup>
                <col style={{ width: 38 }} />
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
                    {props.map((p, ci) => {
                      const inSel = cr != null && ri >= cr.r0 && ri <= cr.r1 && ci >= cr.c0 && ci <= cr.c1;
                      const boxShadow = cr ? edgeShadow(cr, ri, ci) : undefined;
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
                            seed={editing?.rec === rec.id && editing?.prop === p.id ? editing.seed : undefined}
                            onEdit={() => { selectCell(ri, ci); setEditing({ rec: rec.id, prop: p.id }); }}
                            onCommit={(v) => commit(rec, p, v)}
                            onDone={(end) => {
                              setEditing(null);
                              if (end.reason !== "cancel" && end.changed) commit(rec, p, end.value);
                              // Tab/Shift+Tab walk the row; Enter moves the selection down
                              // (Airtable-style) without editing. With an active sort the
                              // commit may re-order rows — the move targets pre-commit indices.
                              if (end.reason === "tab") moveEditNeighbor(ri, ci, +1);
                              else if (end.reason === "shifttab") moveEditNeighbor(ri, ci, -1);
                              else if (end.reason === "enter") selectCell(clampN(ri + 1, 0, sorted.length - 1), ci);
                            }}
                            onOpen={() => openPeek(rec.id)}
                            onRelCreated={() => relCreated(p)}
                            onRowMenu={(e) => openRowMenu(e, rec, () => openPeek(rec.id), () => duplicateRecord(rec), () => deleteRecords([rec.id]))}
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
          onClose={closePeek}
          onCommit={(p, v) => commit(peekRec, p, v)}
          onDelete={() => deleteRecords([peekRec.id])}
          onDuplicate={() => duplicateRecord(peekRec)}
          onReverted={() => reload().catch((e) => onError(String(e.message)))}
          onRelCreated={relCreated}
        />
      )}
    </div>
  );
}

// ---- cell ----
/** How an editing session ended: cancel discards; every other reason carries
 *  the coerced value plus whether it differs from what the editor opened with —
 *  callers skip the API call (and the history entry) when nothing changed. */
type EditEnd =
  | { reason: "cancel" }
  | { reason: "blur" | "enter" | "tab" | "shifttab"; changed: boolean; value: unknown };

/** Single-field inline editor for text/number/date/url values. Shared by the
 *  grid cells and the record peek panel. relation never comes through here —
 *  it edits via the record picker (openRelationMenu).
 *
 *  Uncontrolled on purpose: the DOM value is seeded once on mount. A controlled
 *  `value=` prop would be re-applied by any parent re-render that lands before
 *  blur (e.g. pointerdown on another cell updating the selection), wiping what
 *  the user typed and committing the stale value — the old "must press Enter
 *  or lose the edit" bug. */
function InlineEditInput({
  prop, val, seed, captureTab, onDone,
}: {
  prop: Prop; val: unknown;
  /** type-to-edit: opens the editor with this text, replacing the old value */
  seed?: string;
  /** grid: Tab commits and moves to the neighbor; peek: leave Tab to the browser */
  captureTab?: boolean;
  onDone: (end: EditEnd) => void;
}) {
  const initial = val == null ? "" : String(val);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current!;
    el.value = seed ?? initial;
    el.focus();
    try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* number/date inputs throw */ }
  }, []);
  // Single exit point: Enter/Escape/Tab unmount the input, which fires a blur —
  // the `done` flag keeps that trailing blur from reporting a second end.
  const finish = (reason: EditEnd["reason"]) => {
    if (done.current) return;
    done.current = true;
    if (reason === "cancel") return onDone({ reason: "cancel" });
    const raw = ref.current!.value;
    onDone({ reason, changed: raw !== initial, value: coerceInput(prop.type, raw) });
  };
  return (
    <input
      ref={ref}
      class="inlineedit"
      type={prop.type === "number" ? "number" : prop.type === "date" ? "date" : "text"}
      onBlur={() => finish("blur")}
      onKeyDown={(e) => {
        if (e.isComposing || e.keyCode === 229) return; // IME: Enter confirms the candidate, not the cell
        if (e.key === "Enter") { e.preventDefault(); finish("enter"); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish("cancel"); }
        else if (e.key === "Tab" && captureTab) { e.preventDefault(); finish(e.shiftKey ? "shifttab" : "tab"); }
      }}
    />
  );
}

function CellView({
  rec, prop, first, editing, seed, onEdit, onCommit, onDone, onOpen, onRowMenu, onRelCreated,
}: {
  rec: Rec; prop: Prop; first: boolean; editing: boolean; seed?: string;
  onEdit: () => void; onCommit: (v: unknown) => void; onDone: (end: EditEnd) => void;
  onOpen: () => void; onRowMenu: (e: MouseEvent) => void; onRelCreated: () => void;
}) {
  const val = rec.cells[prop.id];

  if (prop.type === "checkbox") {
    return (
      <div class="cell center">
        <input type="checkbox" checked={!!val} style={{ width: 16, height: 16, accentColor: "var(--accent)" }} onChange={() => onCommit(!val)} />
      </div>
    );
  }

  // Single click selects the cell (handled by the <td> pointer handler); double click edits.
  const onActivate = (e: MouseEvent) => {
    if (prop.type === "select" || prop.type === "multi_select") openSelectMenu(e, prop, val, onCommit);
    else if (prop.type === "relation") openRelationMenu(e, prop, val, onCommit, undefined, onRelCreated);
    else if (prop.type === "doc") openDocMenu(e, val, onCommit);
    else onEdit();
  };

  const body = <CellDisplay prop={prop} val={val} />;
  const display = first ? (
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
  ) : (
    <div class="cell" onDblClick={onActivate}>{body}</div>
  );

  // The editor overlays the td (.celledit is absolute over the relative cell-td)
  // while the display content stays in flow — the row height never changes.
  // select / multi_select never enter the editing state (menu opens on click).
  return (
    <>
      {display}
      {editing && prop.type !== "select" && prop.type !== "multi_select" && (
        <div class="celledit">
          <InlineEditInput prop={prop} val={val} seed={seed} captureTab onDone={onDone} />
        </div>
      )}
    </>
  );
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
      prop={prop}
      onPick={(v) => { onCommit(v); if (!multi) close(); }}
    />
  ), { minWidth: 220 });
}
function SelectMenu({ multi, options, value, onPick, prop }: { multi: boolean; options: string[]; value: unknown; onPick: (v: unknown) => void; prop: Prop }) {
  const [opts, setOpts] = useState<string[]>(options);
  const [cur, setCur] = useState<unknown>(value);
  const [query, setQuery] = useState("");
  const [selIdx, setSelIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim();
  const filtered = q ? opts.filter((o) => o.toLowerCase().includes(q.toLowerCase())) : opts;
  const canCreate = q.length > 0 && !opts.includes(q);
  const rowCount = filtered.length + (canCreate ? 1 : 0);
  const sel = Math.min(selIdx, Math.max(0, rowCount - 1));
  useEffect(() => {
    listRef.current?.querySelector(".item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel, query]);

  const isOn = (o: string) => (multi ? (Array.isArray(cur) ? cur.includes(o) : false) : cur === o);
  const pick = (o: string) => {
    if (multi) {
      const set = new Set(Array.isArray(cur) ? (cur as string[]) : []);
      set.has(o) ? set.delete(o) : set.add(o);
      const next = [...set];
      setCur(next);
      onPick(next);
      setQuery("");
      setSelIdx(0);
    } else {
      setCur(o);
      onPick(o);
    }
  };
  // Creating a tag from the cell picker persists it into the property schema
  // (config is a merge patch server-side, so sibling keys survive), then picks
  // it right away — Notion-style type-to-create.
  const create = () => {
    if (!canCreate) return;
    const v = q;
    api.updateProperty(prop.id, { config: { options: [...opts, v] } })
      .then(() => { setOpts((os) => [...os, v]); pick(v); })
      .catch((e) => toast(`创建选项失败：${(e as Error).message}`));
  };
  const activate = (i: number) => { if (i < filtered.length) pick(filtered[i]!); else create(); };

  return (
    <>
      <div class="selsearch">
        <Icon name="search" cls="ico sm" />
        <input
          placeholder="搜索或创建选项"
          value={query}
          ref={(el) => { if (el && document.activeElement !== el) el.focus(); }}
          onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setSelIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSelIdx(Math.min(sel + 1, rowCount - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSelIdx(Math.max(sel - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); activate(sel); }
            else if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
          }}
        />
      </div>
      <div ref={listRef}>
        {filtered.map((o, i) => (
          <button key={o} class={"item" + (i === sel ? " sel" : "")} onClick={() => pick(o)} onMouseEnter={() => setSelIdx(i)}>
            <Chip text={o} />
            {isOn(o) && <span class="chk"><Icon name="check" cls="ico sm" /></span>}
          </button>
        ))}
        {canCreate && (
          <button
            class={"item" + (sel === filtered.length ? " sel" : "")}
            onClick={create}
            onMouseEnter={() => setSelIdx(filtered.length)}
          >
            <span class="lico plain"><Icon name="plus" cls="ico sm" /></span>
            创建
            <Chip text={q} />
          </button>
        )}
      </div>
      {multi && Array.isArray(cur) && cur.length > 0 && (
        <>
          <MenuSep />
          <MenuItem icon="x" label="清空" onClick={() => { setCur([]); onPick([]); }} />
        </>
      )}
    </>
  );
}

// ---- relation editor menu (record picker) ----
/** Anchor is a real click from the grid/peek or a synthesized cell rect from
 *  the keyboard path — only a MouseEvent needs its propagation stopped. */
function openRelationMenu(
  anchor: MenuAnchor,
  prop: Prop,
  val: unknown,
  onCommit: (v: unknown) => void,
  seed?: string,
  onCreated?: () => void,
) {
  if (anchor instanceof MouseEvent) anchor.stopPropagation();
  openMenu(anchor, () => (
    <RelationMenu prop={prop} value={val} onPick={onCommit} seed={seed} onCreated={onCreated} />
  ), { minWidth: 260 });
}
function RelationMenu({ prop, value, onPick, seed, onCreated }: {
  prop: Prop; value: unknown; onPick: (v: unknown) => void;
  /** type-to-edit: opens with this text in the search box */
  seed?: string;
  /** fired after a record is created in the TARGET db (self-relation reload) */
  onCreated?: () => void;
}) {
  const target = prop.config?.database;
  const [cur, setCur] = useState<string[]>(Array.isArray(value) ? (value as string[]) : []);
  const [query, setQuery] = useState(seed ?? "");
  const [selIdx, setSelIdx] = useState(0);
  const [, bump] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const un = onRelationTitleChange(() => bump((n) => n + 1));
    bump((n) => n + 1); // a fast load may have notified before we subscribed
    return un;
  }, []);

  const state = target ? relationTitleState(target) : "error";
  const all = target ? relationTitleList(target) : [];
  const q = query.trim();
  // Records legally share titles (unlike select options), so everything below
  // keys and checks by record id, and "创建" stays available on an exact match.
  const matches = q
    ? all.filter((r) => (r.title ?? "").toLowerCase().includes(q.toLowerCase()))
    : all;
  const CAP = 50;
  const shown = matches.slice(0, CAP);
  // No text property in the target db → nowhere to write the new title.
  const titleProp = target ? relationTitleProp(target) : null;
  const canCreate = !!target && q.length > 0 && !!titleProp;
  const rowCount = shown.length + (canCreate ? 1 : 0);
  const sel = Math.min(selIdx, Math.max(0, rowCount - 1));
  useEffect(() => {
    listRef.current?.querySelector(".item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel, query]);

  const pick = (id: string) => {
    const set = new Set(cur);
    set.has(id) ? set.delete(id) : set.add(id);
    const next = [...set];
    setCur(next);
    onPick(next);
    setQuery("");
    setSelIdx(0);
  };
  const create = () => {
    if (!canCreate || !target || !titleProp) return;
    const title = q;
    api.createRecord(target, { [titleProp]: title })
      .then((r) => {
        // seed the cache so the new chip never flashes its raw id
        primeRelationTitle(target, r.id, title);
        onCreated?.();
        pick(r.id);
      })
      .catch((e) => toast(`创建记录失败：${(e as Error).message}`));
  };
  const activate = (i: number) => { if (i < shown.length) pick(shown[i]!.id); else create(); };

  return (
    <>
      <div class="selsearch">
        <Icon name="search" cls="ico sm" />
        <input
          placeholder="搜索或创建记录"
          value={query}
          ref={(el) => { if (el && document.activeElement !== el) el.focus(); }}
          onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setSelIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSelIdx(Math.min(sel + 1, rowCount - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSelIdx(Math.max(sel - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); activate(sel); }
            else if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
          }}
        />
      </div>
      <div ref={listRef} class="rellist">
        {!target && <MenuLabel>该属性未设置关联目标</MenuLabel>}
        {target && state === "loading" && <MenuLabel>加载中…</MenuLabel>}
        {target && state === "error" && <MenuLabel>无法加载目标数据表</MenuLabel>}
        {target && state !== "loading" && state !== "error" && all.length === 0 && (
          <MenuLabel>目标数据表暂无记录</MenuLabel>
        )}
        {shown.map((r, i) => (
          <button key={r.id} class={"item" + (i === sel ? " sel" : "")} onClick={() => pick(r.id)} onMouseEnter={() => setSelIdx(i)}>
            <Chip text={relationLabel(target, r.id)} />
            {cur.includes(r.id) && <span class="chk"><Icon name="check" cls="ico sm" /></span>}
          </button>
        ))}
        {matches.length > CAP && <MenuLabel>还有 {matches.length - CAP} 条，继续输入过滤</MenuLabel>}
        {canCreate && (
          <button
            class={"item" + (sel === shown.length ? " sel" : "")}
            onClick={create}
            onMouseEnter={() => setSelIdx(shown.length)}
          >
            <span class="lico plain"><Icon name="plus" cls="ico sm" /></span>
            创建
            <Chip text={q} />
          </button>
        )}
      </div>
      {cur.length > 0 && (
        <>
          <MenuSep />
          <MenuItem icon="x" label="清空" onClick={() => { setCur([]); onPick([]); }} />
        </>
      )}
    </>
  );
}

// ---- doc editor menu (document picker) ----
// Mirrors the relation picker, but documents are global: no target database,
// no per-db bucket state — the shared doc-title map (primed by App.reloadNav)
// is the whole data source. Kept separate from RelationMenu on purpose: the
// data-source shapes differ enough that an abstraction would obscure both.
function openDocMenu(
  anchor: MenuAnchor,
  val: unknown,
  onCommit: (v: unknown) => void,
  seed?: string,
) {
  if (anchor instanceof MouseEvent) anchor.stopPropagation();
  openMenu(anchor, () => <DocMenu value={val} onPick={onCommit} seed={seed} />, { minWidth: 260 });
}
function DocMenu({ value, onPick, seed }: {
  value: unknown; onPick: (v: unknown) => void;
  /** type-to-edit: opens with this text in the search box */
  seed?: string;
}) {
  const [cur, setCur] = useState<string[]>(Array.isArray(value) ? (value as string[]) : []);
  const [query, setQuery] = useState(seed ?? "");
  const [selIdx, setSelIdx] = useState(0);
  const [, bump] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const un = onDocTitleChange(() => bump((n) => n + 1));
    bump((n) => n + 1); // a fast load may have notified before we subscribed
    return un;
  }, []);

  // The title map also carries db entries (for [[db_x]] links) — docs only here.
  const all = allDocTitles().filter((d) => d.id.startsWith("doc_"));
  const q = query.trim();
  // Documents legally share titles, so everything below keys and checks by doc
  // id, and "创建" stays available on an exact match.
  const matches = q
    ? all.filter((d) => d.title.toLowerCase().includes(q.toLowerCase()))
    : all;
  const CAP = 50;
  const shown = matches.slice(0, CAP);
  const canCreate = q.length > 0;
  const rowCount = shown.length + (canCreate ? 1 : 0);
  const sel = Math.min(selIdx, Math.max(0, rowCount - 1));
  useEffect(() => {
    listRef.current?.querySelector(".item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel, query]);

  const pick = (id: string) => {
    const set = new Set(cur);
    set.has(id) ? set.delete(id) : set.add(id);
    const next = [...set];
    setCur(next);
    onPick(next);
    setQuery("");
    setSelIdx(0);
  };
  const create = () => {
    if (!canCreate) return;
    const title = q;
    api.createDocument({ title })
      .then((d) => {
        // seed the cache so the new chip never flashes its raw id
        primeDocTitle(d.id, title);
        pick(d.id);
      })
      .catch((e) => toast(`创建文档失败：${(e as Error).message}`));
  };
  const activate = (i: number) => { if (i < shown.length) pick(shown[i]!.id); else create(); };

  return (
    <>
      <div class="selsearch">
        <Icon name="search" cls="ico sm" />
        <input
          placeholder="搜索或创建文档"
          value={query}
          ref={(el) => { if (el && document.activeElement !== el) el.focus(); }}
          onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setSelIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSelIdx(Math.min(sel + 1, rowCount - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSelIdx(Math.max(sel - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); activate(sel); }
            else if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
          }}
        />
      </div>
      <div ref={listRef} class="rellist">
        {all.length === 0 && !canCreate && <MenuLabel>暂无文档，输入标题创建</MenuLabel>}
        {shown.map((d, i) => (
          <button key={d.id} class={"item" + (i === sel ? " sel" : "")} onClick={() => pick(d.id)} onMouseEnter={() => setSelIdx(i)}>
            <Chip text={docLabel(d.id).label} />
            {cur.includes(d.id) && <span class="chk"><Icon name="check" cls="ico sm" /></span>}
          </button>
        ))}
        {matches.length > CAP && <MenuLabel>还有 {matches.length - CAP} 条，继续输入过滤</MenuLabel>}
        {canCreate && (
          <button
            class={"item" + (sel === shown.length ? " sel" : "")}
            onClick={create}
            onMouseEnter={() => setSelIdx(shown.length)}
          >
            <span class="lico plain"><Icon name="plus" cls="ico sm" /></span>
            创建
            <Chip text={q} />
          </button>
        )}
      </div>
      {cur.length > 0 && (
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
  const [target, setTarget] = useState<string | undefined>(prop.config?.database);
  const [editing, setEditing] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null); // only one row edits at a time

  const persist = (patch: { name?: string; type?: PropType; config?: PropConfig }) =>
    api.updateProperty(prop.id, patch).then(reload).catch((e) => toast(`更新属性失败：${(e as Error).message}`));

  const changeType = (t: PropType) => {
    setType(t);
    if (t === "relation") {
      // relation is only valid with a target database — without one, defer the
      // persist to the target list below; with one (kept in config through
      // type flips — config is a merge patch), re-attach it explicitly since
      // the type change re-validates.
      if (target) persist({ type: t, config: { database: target } });
      return;
    }
    let opts = options;
    if ((t === "select" || t === "multi_select") && opts.length === 0) {
      opts = ["选项 1", "选项 2"];
      setOptions(opts);
    }
    persist({ type: t, ...(t === "select" || t === "multi_select" ? { config: { options: opts } } : {}) });
  };
  const setOpts = (next: string[]) => { setOptions(next); persist({ config: { options: next } }); };

  // Renames go through the dedicated cascade op — the server rewrites every
  // cell holding the old string, so existing records follow the new name.
  const renameOpt = (from: string, raw: string) => {
    setEditing(null);
    const to = raw.trim();
    if (!to || to === from) return;
    if (options.includes(to)) { toast("已存在同名选项"); return; }
    const prev = options;
    setOptions(prev.map((o) => (o === from ? to : o)));
    api.renameSelectOption(prop.id, from, to).then(reload).catch((e) => {
      setOptions(prev);
      toast(`重命名选项失败：${(e as Error).message}`);
    });
  };

  const removeOpt = async (o: string) => {
    if (options.length === 1) { toast("至少保留一个选项"); return; }
    // aboveMenus stacks the dialog over this popover, so the menu survives it
    const ok = await confirmDialog({ title: "删除选项？", message: `「${o}」将从所有使用它的记录中清除。`, confirmLabel: "删除", danger: true, aboveMenus: true });
    if (!ok) return;
    const prev = options;
    setOptions(prev.filter((x) => x !== o));
    api.removeSelectOption(prop.id, o).then(reload).catch((e) => {
      setOptions(prev);
      toast(`删除选项失败：${(e as Error).message}`);
    });
  };

  const addOpt = (input: HTMLInputElement) => {
    const v = input.value.trim();
    if (!v) return;
    if (options.includes(v)) { toast("已存在同名选项"); return; }
    input.value = "";
    setOpts([...options, v]);
  };

  const startOptDrag = (e: any, o: string) => {
    if (e.button !== 0) return;
    const source = (e.currentTarget as HTMLElement).closest(".optrow") as HTMLElement | null;
    if (!source) return;
    startGhostDrag(e, {
      source,
      axis: "y",
      ghostCls: "col-ghost",
      ghostText: o,
      targetSelector: ".optrow[data-opt]",
      isSelf: (el) => el.dataset.opt === o,
      onDrop: (el, where) => {
        const next = options.filter((x) => x !== o);
        let to = next.indexOf(el.dataset.opt!);
        if (to < 0) return;
        if (where === "after") to += 1;
        next.splice(to, 0, o);
        setOpts(next);
      },
    });
  };

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
          {options.map((o) => (
            <div key={o} class="optrow" data-opt={o}>
              {editing === o ? (
                <>
                  {/* mirrors the display row element-for-element (grip + pill +
                      two 22px buttons) so entering edit never changes the row's
                      geometry — only the ring fades in */}
                  <span class="grip dim"><Icon name="grip" cls="ico sm" /></span>
                  <input
                    class="optedit"
                    style={{ ["--c" as any]: optColor(o) }}
                    defaultValue={o}
                    ref={(el) => { editRef.current = el; if (el && document.activeElement !== el) { el.focus(); el.select(); } }}
                    onKeyDown={(e) => {
                      const input = e.target as HTMLInputElement;
                      if (e.key === "Enter") input.blur();
                      else if (e.key === "Escape") { input.dataset.cancel = "1"; input.blur(); }
                    }}
                    onBlur={(e) => {
                      const input = e.target as HTMLInputElement;
                      if (input.dataset.cancel) setEditing(null);
                      else renameOpt(o, input.value);
                    }}
                  />
                  {/* mousedown preventDefault keeps focus on the input so blur
                      (= the commit/cancel path) fires exactly once, on our terms */}
                  <button
                    class="x ok" title="确认"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => editRef.current?.blur()}
                  ><Icon name="check" cls="ico sm" /></button>
                  <button
                    class="x cancel" title="取消"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (editRef.current) editRef.current.dataset.cancel = "1";
                      setEditing(null);
                    }}
                  ><Icon name="x" cls="ico sm" /></button>
                </>
              ) : (
                <>
                  <span class="grip" onPointerDown={(e) => startOptDrag(e, o)}><Icon name="grip" cls="ico sm" /></span>
                  <button class="optlabel" title="重命名选项" onClick={() => setEditing(o)}><Chip text={o} /></button>
                  <button class="x" title="重命名选项" onClick={() => setEditing(o)}><Icon name="pencil" cls="ico sm" /></button>
                  <button class="x del" title="删除选项" onClick={() => removeOpt(o)}><Icon name="x" cls="ico sm" /></button>
                </>
              )}
            </div>
          ))}
          <div class="optrow optadd">
            <span class="grip dim"><Icon name="plus" cls="ico sm" /></span>
            <input
              placeholder="添加选项"
              onKeyDown={(e) => { if (e.key === "Enter") addOpt(e.target as HTMLInputElement); }}
            />
          </div>
        </>
      )}
      {type === "relation" && (
        <>
          <MenuSep />
          <MenuLabel>{target ? "关联目标" : "选择关联的数据表"}</MenuLabel>
          <DbTargetList
            currentDb={dbId}
            target={target}
            onPick={(d) => {
              setTarget(d.id);
              persist({ type: "relation", config: { database: d.id } });
            }}
          />
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

/** Target-database list for relation properties. Every database is listed —
 *  self-relation is legal, so the current table appears too, just labeled. */
function DbTargetList({ currentDb, target, autoFocus, onPick }: {
  currentDb: string; target?: string;
  /** steal focus only in the dedicated pick step — ColMenu has a rename input on top */
  autoFocus?: boolean;
  onPick: (d: Db) => void;
}) {
  const [dbs, setDbs] = useState<Db[] | null>(null);
  const [query, setQuery] = useState("");
  const [selIdx, setSelIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { api.listDatabases().then(setDbs).catch(() => setDbs([])); }, []);

  const q = query.trim().toLowerCase();
  const all = dbs ?? [];
  const matches = q ? all.filter((d) => (d.name || "未命名数据库").toLowerCase().includes(q)) : all;
  const CAP = 50;
  const shown = matches.slice(0, CAP);
  const sel = Math.min(selIdx, Math.max(0, shown.length - 1));
  useEffect(() => {
    listRef.current?.querySelector(".item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel, query]);

  if (!dbs) return null;
  return (
    <>
      <div class="selsearch">
        <Icon name="search" cls="ico sm" />
        <input
          placeholder="搜索数据表"
          value={query}
          ref={autoFocus ? (el) => { if (el && document.activeElement !== el) el.focus(); } : undefined}
          onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setSelIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSelIdx(Math.min(sel + 1, shown.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSelIdx(Math.max(sel - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); if (shown[sel]) onPick(shown[sel]); }
            else if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
          }}
        />
      </div>
      <div ref={listRef} class="rellist">
        {shown.length === 0 && <MenuLabel>无匹配结果</MenuLabel>}
        {shown.map((d, i) => (
          <MenuItem
            key={d.id}
            icon="database"
            label={d.name || "未命名数据库"}
            sublabel={d.id === currentDb ? "当前表" : undefined}
            checked={d.id === target}
            sel={i === sel}
            onHover={() => setSelIdx(i)}
            onClick={() => onPick(d)}
          />
        ))}
        {matches.length > CAP && <MenuLabel>还有 {matches.length - CAP} 条，继续输入过滤</MenuLabel>}
      </div>
    </>
  );
}

function openAddCol(e: MouseEvent, dbId: string, allProps: Prop[], reload: () => Promise<void>) {
  e.stopPropagation();
  openMenu(e, (close) => <AddColMenu dbId={dbId} allProps={allProps} reload={reload} close={close} />);
}
function AddColMenu({ dbId, allProps, reload, close }: { dbId: string; allProps: Prop[]; reload: () => Promise<void>; close: () => void }) {
  // relation can't be created from the type alone — it needs a target database,
  // so picking it swaps the menu to a second step instead of creating.
  const [pickTarget, setPickTarget] = useState(false);
  const create = (t: PropType, config: PropConfig | undefined, base: string) => {
    close();
    api.createProperty({ db: dbId, name: uniquePropName(base, allProps), type: t, config })
      .then(reload)
      .catch((e) => toast(`新建属性失败：${(e as Error).message}`));
  };
  if (pickTarget)
    return (
      <>
        <MenuLabel>选择关联的数据表</MenuLabel>
        <DbTargetList currentDb={dbId} autoFocus onPick={(d) => create("relation", { database: d.id }, d.name || TYPE_META.relation.t)} />
        <MenuSep />
        <MenuItem icon="arrowLeft" label="返回" onClick={() => setPickTarget(false)} />
      </>
    );
  return (
    <>
      <MenuLabel>新建属性 · 选择类型</MenuLabel>
      <div class="typegrid">
        {(Object.keys(TYPE_META) as PropType[]).map((t) => (
          <button key={t} class="item" onClick={() => {
            if (t === "relation") { setPickTarget(true); return; }
            const cfg = t === "select" || t === "multi_select" ? { options: ["选项 1", "选项 2"] } : undefined;
            create(t, cfg, TYPE_META[t].t);
          }}>
            <span class="lico"><Icon name={TYPE_ICON[t]!} cls="ico sm" /></span>
            <span class="d">{TYPE_META[t].t}</span>
          </button>
        ))}
      </div>
    </>
  );
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
export function RecordPeek({
  db, props, rec, onClose, onCommit, onDelete, onDuplicate, onReverted, onRelCreated,
}: {
  db: Db; props: Prop[]; rec: Rec;
  onClose: () => void; onCommit: (p: Prop, v: unknown) => void; onDelete: () => void; onDuplicate: () => void;
  onReverted: () => void; onRelCreated: (p: Prop) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [hist, setHist] = useState(false);
  const { open, close } = useDrawerTransition(onClose);
  const { width, handle } = useDrawerResize("mh.peekW");
  const titleProp = props[0];
  return (
    <>
      <div class={"scrim" + (open ? " open" : "")} onClick={close} />
      <div class={"peek" + (open ? " open" : "")} style={width != null ? { width: `${width}px` } : undefined}>
        {handle}
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
              <h2
                contentEditable
                {...plainPasteHandlers()}
                onBlur={(e) => titleProp && onCommit(titleProp, (e.target as HTMLElement).textContent ?? "")}
              >
                {titleProp ? String(rec.cells[titleProp.id] ?? "无标题") : "无标题"}
              </h2>
              {props.map((p) => (
                <div key={p.id} class="proprow">
                  <div
                    class="k"
                    onClick={(e) =>
                      openMenu(e, (close) => (
                        <MenuItem icon="history" label="字段修改历史" onClick={() => { close(); openFieldHistory(rec.id, p.id, p.name); }} />
                      ))
                    }
                  ><Icon name={TYPE_ICON[p.type] ?? "text"} cls="ico sm" /><span>{p.name}</span></div>
                  <PeekValue
                    prop={p}
                    rec={rec}
                    editing={editing === p.id}
                    onEdit={() => setEditing(p.id)}
                    onCommit={(v) => { onCommit(p, v); setEditing(null); }}
                    onCloseEdit={() => setEditing(null)}
                    onRelCreated={() => onRelCreated(p)}
                  />
                </div>
              ))}
              <PeekDocs props={props} rec={rec} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** The row's linked documents (union of its doc-type cells), embedded below the
 *  property list: a tab per document, the active one editable in place via a
 *  compact DocView. Renders nothing when the row links no documents. */
function PeekDocs({ props, rec }: { props: Prop[]; rec: Rec }) {
  const [, bump] = useState(0);
  useEffect(() => onDocTitleChange(() => bump((n) => n + 1)), []);
  const linked: { id: string; propName: string }[] = [];
  const seen = new Set<string>();
  for (const p of props) {
    if (p.type !== "doc") continue;
    const v = rec.cells[p.id];
    if (!Array.isArray(v)) continue;
    for (const x of v) {
      const id = String(x);
      if (!seen.has(id)) { seen.add(id); linked.push({ id, propName: p.name }); }
    }
  }
  const [sel, setSel] = useState<string | null>(null);
  const handleRef = useRef<DocViewHandle | null>(null);
  // DocView reports its handle on mount and null on unmount (tab/row switch,
  // drawer close). Flushing on the null keeps the debounce window from
  // swallowing the last edits — the editor's state outlives its DOM, so the
  // snapshot is still exact.
  const onHandle = useCallback((h: DocViewHandle | null) => {
    if (h === null) void handleRef.current?.flushSave();
    handleRef.current = h;
  }, []);
  if (linked.length === 0) return null;
  const activeId = linked.some((d) => d.id === sel) ? sel! : linked[0]!.id;
  const activeMissing = docLabel(activeId).missing;
  return (
    <>
      <div class="peek-divider" />
      <div class="peekdocs-tabs">
        {linked.map((d) => {
          const { label, missing } = docLabel(d.id);
          return (
            <button
              key={d.id}
              class={"peekdocs-tab" + (d.id === activeId ? " active" : "") + (missing ? " missing" : "")}
              title={d.propName}
              onClick={() => setSel(d.id)}
            >{label}</button>
          );
        })}
        <div style={{ flex: 1 }} />
        {!activeMissing && (
          <a class="iconbtn peekdocs-open" title="在主视图打开" href={`#/doc/${encodeURIComponent(activeId)}`}>
            <Icon name="cornerUpRight" cls="ico sm" />
          </a>
        )}
      </div>
      {activeMissing ? (
        <div class="empty">文档不存在或未同步</div>
      ) : (
        <DocView key={activeId} docId={activeId} embedded onError={(m) => toast(m)} onHandle={onHandle} />
      )}
    </>
  );
}

function PeekValue({ prop, rec, editing, onEdit, onCommit, onCloseEdit, onRelCreated }: {
  prop: Prop; rec: Rec; editing: boolean;
  onEdit: () => void; onCommit: (v: unknown) => void; onCloseEdit: () => void;
  onRelCreated: () => void;
}) {
  const val = rec.cells[prop.id];
  if (prop.type === "checkbox")
    return <div class="v"><input type="checkbox" checked={!!val} style={{ width: 16, height: 16, accentColor: "var(--accent)" }} onChange={() => onCommit(!val)} /></div>;
  if (prop.type === "select" || prop.type === "multi_select")
    return <div class="v" onClick={(e) => openSelectMenu(e as unknown as MouseEvent, prop, val, onCommit)}><CellDisplay prop={prop} val={val} /></div>;
  // Chip clicks navigate (the anchor stops propagation); empty-area clicks edit.
  if (prop.type === "relation")
    return <div class="v" onClick={(e) => openRelationMenu(e as unknown as MouseEvent, prop, val, onCommit, undefined, onRelCreated)}><CellDisplay prop={prop} val={val} /></div>;
  if (prop.type === "doc")
    return <div class="v" onClick={(e) => openDocMenu(e as unknown as MouseEvent, val, onCommit)}><CellDisplay prop={prop} val={val} /></div>;
  if (editing) {
    // No captureTab: in the peek panel Tab follows native focus order and the
    // resulting blur commits. onCommit closes the editor via the parent.
    return (
      <div class="v">
        <InlineEditInput
          prop={prop}
          val={val}
          onDone={(end) => {
            if (end.reason !== "cancel" && end.changed) onCommit(end.value);
            else onCloseEdit();
          }}
        />
      </div>
    );
  }
  return <div class="v" onClick={onEdit}><CellDisplay prop={prop} val={val} /></div>;
}
