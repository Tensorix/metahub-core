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
import { imeGhost, isEditableTarget } from "./keys.ts";
import { openDatePicker } from "./date-picker.tsx";
import { useSkeletonRows } from "./skeleton.tsx";
import { tip, pressed } from "./shortcuts.ts";
import { undoableDelete } from "./undo.ts";
import { rankMatches } from "./title-match.ts";
import { docParentChain } from "./doc-titles.ts";
import { t } from "./i18n/t.ts";
import { openShareModal, useSharedTargets } from "./share-modal.tsx";
import {
  openMenu,
  closeMenu,
  Highlight,
  MenuItem,
  MenuLabel,
  MenuSep,
  ReturnHint,
  confirmDialog,
  promptDialog,
  useDrawerResize,
  useDrawerTransition,
  toast,
  type MenuAnchor,
} from "./ui.tsx";
import { SYNCED_EVENT } from "./data/replica.ts";
import { type DbTab } from "./view.ts";
import { Chip, CellDisplay, coerceInput, cellText, optColor, relationLabel, docLabel, isPlainTextEditable } from "./cells.tsx";
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
import {
  normalizeViews, emptyView, newViewId, applyFilter, applySort, searchRecords, calcKindsFor, calcLabel, computeCalc, condsFor,
  type ViewDef, type Layout, type CalcKind, type FilterRule,
} from "./view-model.ts";
import { ViewTabs, ViewToolbar, ChipRow, openRuleEditor, type ViewPatch, type PickRefs } from "./view-bar.tsx";
import { parseGrid, pastePatches, type CellPatch } from "./table-paste.ts";


/** 「浮窗看板」— summon the desktop quick-board window on this database. Sits
 *  at the right end of the row under the view tabs (table toolbar / board
 *  bar), styled like its toolbar siblings (排序/分组). Renders nothing outside
 *  the desktop shell or on an older shell without the qb:show bridge. */
function PopOutBoard({ dbId }: { dbId: string }) {
  if (!window.metahubDesktop?.quickboard?.show) return null;
  return (
    <button
      class="popout-btn"
      {...tip(t("在浮窗中打开这个数据库的看板"))}
      onClick={() => {
        // Point the quick-board window at this database: localStorage covers
        // a cold mount, the broadcast switches an already-warm hidden window
        // (listener in quickboard/quickboard.tsx).
        localStorage.setItem("mh-quickboard-db", dbId);
        try {
          const ch = new BroadcastChannel("mh-quickboard");
          ch.postMessage({ dbId });
          ch.close();
        } catch {
          /* no BroadcastChannel — the cold-mount path still applies */
        }
        void window.metahubDesktop!.quickboard!.show!();
      }}
    >
      <Icon name="boardPop" />
    </button>
  );
}

export function DatabaseView({
  db,
  rec,
  onRecNav,
  tabReq,
  onTabReq,
  onError,
}: {
  db: Db;
  /** Record deep link from the hash (#/db/<id>/<rec>); the peek mirrors it. */
  rec: string | null;
  /** Replace-navigate the hash when the peek opens/closes, so a chip click on
   *  the SAME record still fires hashchange next time (same-hash clicks don't). */
  onRecNav: (rec: string | null) => void;
  /** View-tab deep link from the hash (#/db/<id>?view=board) — a one-shot
   *  request, consumed then cleared. Manual tab switches never write the hash. */
  tabReq: DbTab | null;
  /** Replace-navigate the hash to strip `?view=` once the request is consumed,
   *  so a repeated request is always a null→value change and fires again. */
  onTabReq: (tab: DbTab | null) => void;
  onError: (m: string) => void;
}) {
  const [props, setProps] = useState<Prop[]>([]);
  const [records, setRecords] = useState<Rec[]>([]);
  const shared = useSharedTargets();
  const [sel, setSel] = useState<Set<string>>(new Set());
  // Saved views live in db.meta.views (replicated); the active one is a device
  // preference. Edits are debounced into one PATCH per burst.
  const [views, setViews] = useState<ViewDef[]>(() => normalizeViews(db.meta?.views));
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const [activeViewId, setActiveViewId] = useState<string>(() => localStorage.getItem(`mh.db.view.${db.id}`) ?? "");
  const view = views.find((v) => v.id === activeViewId) ?? views[0]!;
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistViews = (next: ViewDef[]) => {
    setViews(next);
    viewsRef.current = next;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null;
      api.updateDatabase(db.id, { meta: { views: viewsRef.current } }).catch((e) => onError(String(e.message)));
    }, 300);
  };
  const updateView = (patch: ViewPatch, id = view.id) => persistViews(viewsRef.current.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  const selectView = (id: string) => {
    setActiveViewId(id);
    localStorage.setItem(`mh.db.view.${db.id}`, id);
    setCellSel(null);
    setSel(new Set());
  };
  const createView = (layout: Layout, name: string) => {
    const v = emptyView(layout, name);
    persistViews([...viewsRef.current, v]);
    selectView(v.id);
  };
  const duplicateView = (id: string) => {
    const src = viewsRef.current.find((v) => v.id === id);
    if (!src) return;
    const copy: ViewDef = { ...src, id: newViewId(), name: t("{name} 副本", { name: src.name }) };
    const i = viewsRef.current.indexOf(src);
    persistViews([...viewsRef.current.slice(0, i + 1), copy, ...viewsRef.current.slice(i + 1)]);
    selectView(copy.id);
  };
  const deleteView = (id: string) => {
    const next = viewsRef.current.filter((v) => v.id !== id);
    if (!next.length) return;
    persistViews(next);
    if (id === view.id) selectView(next[0]!.id);
  };
  const sort = view.sort;
  const sorting = sort.length > 0;
  const [query, setQuery] = useState("");
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
  const [skelRows, rememberRows] = useSkeletonRows("table", 4);
  const reload = async () => {
    const [p, r] = await Promise.all([api.listProperties(db.id), api.listRecords(db.id)]);
    setProps(p);
    setRecords(r);
    setLoaded(true);
    rememberRows(r.length);
  };
  useEffect(() => {
    setSel(new Set());
    setPeek(null);
    setCellSel(null);
    setEditing(null);
    setQuery("");
    undoRef.current = { past: [], future: [] };
    const vs = normalizeViews(db.meta?.views);
    setViews(vs);
    viewsRef.current = vs;
    setActiveViewId(localStorage.getItem(`mh.db.view.${db.id}`) ?? vs[0]!.id);
    reload().catch((e) => onError(String(e.message)));
  }, [db.id]);
  // A sync (or another tab) rewrote the saved views: adopt them unless a local
  // edit is still waiting to be flushed.
  useEffect(() => {
    if (persistTimer.current) return;
    const next = normalizeViews(db.meta?.views);
    if (JSON.stringify(next) !== JSON.stringify(viewsRef.current)) { setViews(next); viewsRef.current = next; }
  }, [db.meta]);

  // Peek ⇄ hash. Every internal open/close goes through these two so the hash
  // always mirrors the drawer; the effect below covers the other direction
  // (chip clicks, back/forward). Declared after the db.id reset effect so a
  // deep-linked mount ends with the peek open, not reset.
  const openPeek = (id: string) => { setPeek(id); onRecNav(id); };
  const closePeek = () => { setPeek(null); onRecNav(null); };
  useEffect(() => { setPeek(rec); }, [rec]);
  // Tab request → tab, consumed once then stripped from the hash (replace).
  // Declared after the db.id reset effect so a deep-linked mount ends on the
  // requested tab, not on the reset's 表格.
  useEffect(() => {
    if (!tabReq) return;
    const target = views.find((v) => v.layout === tabReq);
    if (target) selectView(target.id);
    onTabReq(null);
  }, [tabReq]);
  // Dangling deep link (deleted record / forward reference): explain and clear —
  // a silently dead drawer-less hash would make the chip look broken.
  const recordsRef = useRef(records);
  recordsRef.current = records;
  useEffect(() => {
    if (rec && loaded && !recordsRef.current.some((r) => r.id === rec)) {
      toast(t("记录不存在或已被删除"));
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
  // Every write goes through applyCells so one call = one undo step.
  const undoRef = useRef<{ past: CellEdit[][]; future: CellEdit[][] }>({ past: [], future: [] });
  const applyCells = (patches: CellPatch[], opts: { history?: boolean } = {}): Promise<void> => {
    const byRec = new Map<string, Record<string, unknown>>();
    const edits: CellEdit[] = [];
    for (const p of patches) {
      const rec = recordsRef.current.find((r) => r.id === p.recId);
      if (!rec) continue;
      edits.push({ recId: p.recId, propId: p.propId, before: rec.cells[p.propId] ?? null, after: p.value });
      let patch = byRec.get(p.recId);
      if (!patch) { patch = {}; byRec.set(p.recId, patch); }
      patch[p.propId] = p.value;
    }
    if (!edits.length) return Promise.resolve();
    if (opts.history !== false) { undoRef.current.past.push(edits); undoRef.current.future = []; }
    const nameOf = new Map(props.map((p) => [p.id, p.name]));
    setRecords((rs) => rs.map((r) => {
      const patch = byRec.get(r.id);
      if (!patch) return r;
      const values = { ...r.values };
      for (const [pid, v] of Object.entries(patch)) { const n = nameOf.get(pid); if (n) values[n] = v; }
      return { ...r, cells: { ...r.cells, ...patch }, values };
    }));
    return Promise.all([...byRec].map(([id, patch]) => api.updateRecord(id, patch)))
      .then((updates) => setRecords((rs) => rs.map((r) => updates.find((u) => u.id === r.id) ?? r)))
      .catch((e) => {
        onError(String(e.message));
        reload().catch((err) => onError(String(err.message)));
      });
  };
  const commit = (rec: Rec, prop: Prop, value: unknown) => {
    setEditing(null);
    void applyCells([{ recId: rec.id, propId: prop.id, value }]);
  };
  const undoCells = () => {
    const g = undoRef.current.past.pop();
    if (!g) return;
    undoRef.current.future.push(g);
    void applyCells(g.map((e) => ({ recId: e.recId, propId: e.propId, value: e.before })), { history: false });
    toast(t("已撤销"));
  };
  const redoCells = () => {
    const g = undoRef.current.future.pop();
    if (!g) return;
    undoRef.current.past.push(g);
    void applyCells(g.map((e) => ({ recId: e.recId, propId: e.propId, value: e.after })), { history: false });
    toast(t("已重做"));
  };

  const [pendingEdit, setPendingEdit] = useState<string | null>(null);
  const createRecordWith = (values: Record<string, unknown>, edit = false) =>
    guard(async () => {
      const rec = await api.createRecord(db.id, values);
      setRecords((rs) => [...rs, rec]);
      if (edit) setPendingEdit(rec.id);
    });
  const newRecord = () => createRecordWith({}, true);

  const deleteRecords = (ids: string[]) =>
    guard(() =>
      undoableDelete({
        label: t("已删除 {n} 条记录", { n: ids.length }),
        ids,
        run: () => Promise.all(ids.map((id) => api.deleteRecord(id))),
        after: () => {
          setRecords((rs) => rs.filter((r) => !ids.includes(r.id)));
          setSel(new Set());
          if (peek && ids.includes(peek)) closePeek();
        },
        onRestored: () => void reload(),
      }),
    );

  const duplicateRecord = (rec: Rec) =>
    guard(async () => {
      const copy = await api.createRecord(db.id, rec.cells);
      setRecords((rs) => {
        const i = rs.findIndex((r) => r.id === rec.id);
        return [...rs.slice(0, i + 1), copy, ...rs.slice(i + 1)];
      });
      await api.moveRecord(copy.id, rec.id, "after");
    });

  const moveRecordLocal = (srcId: string, targetId: string, where: DropWhere) => {
    if (srcId === targetId || sorting) return;
    setRecords((rs) => reorderById(rs, srcId, targetId, where));
  };

  const persistRecordMove = (srcId: string, targetId: string, where: DropWhere) => {
    if (srcId === targetId || sorting) return;
    moveRecordLocal(srcId, targetId, where);
    api.moveRecord(srcId, targetId, where).catch((e) => {
      onError(String(e.message));
      reload().catch((err) => onError(String(err.message)));
    });
  };

  const persistColumnMove = (srcId: string, targetId: string, where: DropWhere) => {
    if (srcId === targetId) return;
    setProps((cur) => {
      const moved = reorderById(cur, srcId, targetId, where);
      const i = moved.findIndex((p) => p.id === srcId);
      const before = moved[i - 1]?.position;
      const after = moved[i + 1]?.position;
      let position: number;
      if (before == null && after == null) return cur;
      if (before == null) position = after! - 1;
      else if (after == null) position = before + 1;
      else position = (before + after) / 2;
      const collides = position === before || position === after;
      const ordered = collides
        ? moved.map((p, k) => ({ ...p, position: k + 1 }))
        : moved.map((p) => (p.id === srcId ? { ...p, position } : p));
      const prev = new Map(cur.map((p) => [p.id, p.position]));
      const changed = ordered.filter((p) => prev.get(p.id) !== p.position);
      Promise.all(changed.map((p) => api.updateProperty(p.id, { position: p.position }))).catch((e) => {
        onError(String(e.message));
        reload().catch((err) => onError(String(err.message)));
      });
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
    if (sorting || e.button !== 0) return;
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
        const tgt = rowDropTarget(ev.clientY, recId);
        dropRef.current = tgt;
        setDropY(tgt ? tgt.y : null);
      },
      onEnd: (_ev, active) => {
        ghost?.remove();
        source.classList.remove("drag-source");
        document.body.classList.remove("table-dragging");
        const tgt = dropRef.current;
        dropRef.current = null;
        setDropY(null);
        if (active && tgt) persistRecordMove(recId, tgt.id, tgt.where);
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
      ghostText: source.textContent?.trim() || t("移动属性"),
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

  // Press-and-release inside one cell edits it; crossing the 4px drag threshold
  // rubber-bands a range instead. Shift+click only extends the selection.
  const startCellSelect = (e: any, ri: number, ci: number) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("input,textarea,button,a,.celledit,.cell-fill-handle")) return;
    const extend = e.shiftKey && cellSel;
    const anchor = extend ? cellSel.a : { r: ri, c: ci };
    setCellSel({ a: anchor, b: { r: ri, c: ci } });
    if (sel.size) setSel(new Set());
    startPointerDrag(e, {
      onStart: () => document.body.classList.add("cell-selecting"),
      onMove: (ev) => {
        const td = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.("td.cell-td") as HTMLElement | null;
        if (!td || td.dataset.r == null) return;
        setCellSel({ a: anchor, b: { r: Number(td.dataset.r), c: Number(td.dataset.c) } });
      },
      onEnd: (ev, active) => {
        document.body.classList.remove("cell-selecting");
        if (active || extend || ev.type === "pointercancel") return;
        activateCell(ri, ci);
      },
    });
  };

  // ---- keyboard cell navigation / editing ----
  const clampN = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const scrollCellIntoView = (r: number, c: number) =>
    requestAnimationFrame(() => {
      document.querySelector(`td.cell-td[data-r="${r}"][data-c="${c}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  const selectCell = (r: number, c: number) => {
    setCellSel({ a: { r, c }, b: { r, c } });
    if (sel.size) setSel(new Set());
    scrollCellIntoView(r, c);
  };
  const lastRowClick = useRef<string | null>(null);
  const toggleRow = (id: string, shift: boolean) => {
    setSel((s) => {
      const n = new Set(s);
      const anchor = lastRowClick.current;
      if (shift && anchor) {
        const ids = sorted.map((r) => r.id);
        const i = ids.indexOf(anchor), j = ids.indexOf(id);
        if (i >= 0 && j >= 0) {
          for (let k = Math.min(i, j); k <= Math.max(i, j); k++) n.add(ids[k]!);
          return n;
        }
      }
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
    lastRowClick.current = id;
    setCellSel(null);
  };
  const cellAnchor = (r: number, c: number): MenuAnchor => {
    const td = document.querySelector(`td.cell-td[data-r="${r}"][data-c="${c}"]`);
    return td ? { rect: td.getBoundingClientRect() } : { x: innerWidth / 2, y: innerHeight / 3 };
  };

  /** Open the cell's editor: the inline text editor for free-text types, a
   *  picker popover anchored at the cell for the rest, a toggle for checkbox.
   *  `seed` is the type-to-edit first character (replaces the old value /
   *  pre-fills the picker's search). */
  const activateCell = (r: number, c: number, seed?: string) => {
    const recRow = sorted[r];
    const p = cols[c];
    if (!recRow || !p) return;
    selectCell(r, c);
    const val = recRow.cells[p.id];
    const set = (v: unknown) => commit(recRow, p, v);
    switch (p.type) {
      case "checkbox": set(!val); return;
      case "select": case "multi_select": openSelectMenu(cellAnchor(r, c), p, val, set, seed); return;
      case "relation": openRelationMenu(cellAnchor(r, c), p, val, set, seed, () => relCreated(p)); return;
      case "doc": openDocMenu(cellAnchor(r, c), val, set, seed); return;
      case "date": openDatePicker(cellAnchor(r, c), val, set, seed); return;
      default: setEditing({ rec: recRow.id, prop: p.id, seed });
    }
  };
  const isInline = (pt: PropType) => pt === "text" || pt === "number" || pt === "url";
  const startEditAt = (r: number, c: number, seed?: string) => {
    const rec = sorted[r];
    const p = cols[c];
    if (!rec || !p) return;
    selectCell(r, c);
    if (isInline(p.type)) setEditing({ rec: rec.id, prop: p.id, seed });
  };
  const moveEditNeighbor = (r: number, c: number, dc: number) => {
    const nc = c + dc;
    if (nc < 0 || nc >= cols.length) { selectCell(r, c); return; }
    startEditAt(r, nc);
  };
  useEffect(() => {
    if (!pendingEdit) return;
    const r = sorted.findIndex((x) => x.id === pendingEdit);
    if (r < 0) return;
    setPendingEdit(null);
    startEditAt(r, 0);
  }, [pendingEdit, records]);

  /** The picker created a record in prop's target db — a self-relation means
   *  the current table just grew a row it doesn't know about. */
  const relCreated = (p: Prop) => {
    if (p.config?.database === db.id) reload().catch(() => {});
  };

  const rectPatches = (rect: { r0: number; r1: number; c0: number; c1: number }, valueFor: (p: Prop, r: number) => unknown): CellPatch[] => {
    const out: CellPatch[] = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      const rec = sorted[r];
      if (!rec) continue;
      for (let c = rect.c0; c <= rect.c1; c++) {
        const p = cols[c];
        if (!p) continue;
        out.push({ recId: rec.id, propId: p.id, value: valueFor(p, r) });
      }
    }
    return out;
  };
  // Apply a value to every cell in the current selection (one undo step).
  const applyToSelection = (valueFor: (p: Prop) => unknown) => {
    if (!cellSel) return;
    void applyCells(rectPatches(normRect(cellSel), (p) => valueFor(p)));
  };

  // Fill handle: drag the selection's bottom-right corner down to repeat the
  // selected block over the rows below (Excel-style cyclic fill).
  const [fillTo, setFillTo] = useState<number | null>(null);
  const fillToRef = useRef<number | null>(null);
  const startFill = (e: any) => {
    if (e.button !== 0 || !cellSel) return;
    e.preventDefault();
    e.stopPropagation();
    const base = normRect(cellSel);
    startPointerDrag(e, {
      threshold: 2,
      onStart: () => document.body.classList.add("cell-selecting"),
      onMove: (ev) => {
        const td = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.("td.cell-td") as HTMLElement | null;
        if (!td || td.dataset.r == null) return;
        const r = Number(td.dataset.r);
        const to = r > base.r1 ? r : null;
        fillToRef.current = to;
        setFillTo(to);
      },
      onEnd: (_ev, active) => {
        document.body.classList.remove("cell-selecting");
        const to = fillToRef.current;
        fillToRef.current = null;
        setFillTo(null);
        if (!active || to == null) return;
        const h = base.r1 - base.r0 + 1;
        const patches = rectPatches({ r0: base.r1 + 1, r1: to, c0: base.c0, c1: base.c1 }, (p, r) => {
          const src = sorted[base.r0 + ((r - base.r0) % h)];
          return src?.cells[p.id] ?? null;
        });
        void applyCells(patches);
        setCellSel({ a: { r: base.r0, c: base.c0 }, b: { r: to, c: base.c1 } });
      },
    });
  };

  const copySelection = async () => {
    if (!cellSel) return;
    const { r0, r1, c0, c1 } = normRect(cellSel);
    const span = cols.slice(c0, c1 + 1);
    const tsv = sorted.slice(r0, r1 + 1)
      .map((rec) => span.map((p) => cellText(p, rec.cells[p.id])).join("\t"))
      .join("\n");
    try { await navigator.clipboard.writeText(tsv); } catch { /* clipboard blocked */ }
  };

  // Bulk-edit one property across the selected rows: pick the property, then
  // its value through the same picker the cell uses.
  const openSetPropMenu = (e: MouseEvent, ids: string[]) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const anchor: MenuAnchor = { rect };
    const set = (p: Prop) => (v: unknown) => void applyCells(ids.map((id) => ({ recId: id, propId: p.id, value: v })));
    openMenu(e, (close) => (
      <>
        <MenuLabel>{t("设置属性")}</MenuLabel>
        {props.filter((p) => p.type !== "relation" && p.type !== "doc").map((p) => (
          <MenuItem key={p.id} icon={TYPE_ICON[p.type]} label={p.name} onClick={() => {
            close();
            const apply = set(p);
            if (p.type === "select" || p.type === "multi_select") openSelectMenu(anchor, p, null, apply);
            else if (p.type === "date") openDatePicker(anchor, null, apply);
            else if (p.type === "checkbox") openMenu(anchor, (c2) => (
              <>
                <MenuItem icon="check" label={t("勾选")} onClick={() => { c2(); apply(true); }} />
                <MenuItem icon="x" label={t("取消勾选")} onClick={() => { c2(); apply(false); }} />
              </>
            ));
            else promptDialog({ title: p.name, confirmLabel: t("应用") }).then((v) => { if (v !== null) apply(coerceInput(p.type, v)); });
          }} />
        ))}
      </>
    ));
  };

  const colMenuCtx: ColMenuCtx = {
    view,
    records,
    setSort: (propId, desc) => {
      const rest = view.sort.filter((x) => x.prop !== propId);
      updateView({ sort: desc == null ? rest : [{ prop: propId, desc }, ...rest] });
    },
    addFilter: (p, anchor) => {
      const conds = condsFor(p.type);
      const rule: FilterRule = { id: newViewId().replace("v_", "f_"), prop: p.id, cond: conds[0]!.id, value: p.type === "checkbox" ? true : undefined };
      const rules = [...view.filter.rules, rule];
      updateView({ filter: { ...view.filter, rules } });
      openRuleEditor(anchor, p, rule,
        (next) => updateView({ filter: { ...viewsRef.current.find((v) => v.id === view.id)!.filter, rules: viewsRef.current.find((v) => v.id === view.id)!.filter.rules.map((r) => (r.id === next.id ? next : r)) } }),
        () => updateView({ filter: { ...view.filter, rules: viewsRef.current.find((v) => v.id === view.id)!.filter.rules.filter((r) => r.id !== rule.id) } }),
        pickRefs);
    },
    hide: (propId) => updateView({ hidden: [...view.hidden.filter((h) => h !== propId), propId] }),
    toggleWrap: () => updateView({ wrap: view.wrap === false }),
    insert: (p, where, anchor) => openAddCol(anchor, db.id, props, reload, positionNear(props, p, where)),
    duplicate: (p) =>
      guard(async () => {
        const cfg = { ...(p.config ?? {}) };
        const created = await api.createProperty({ db: db.id, name: uniquePropName(t("{name} 副本", { name: p.name }), props), type: p.type, config: Object.keys(cfg).length ? cfg : undefined });
        await api.updateProperty(created.id, { position: positionNear(props, p, "after") });
        await reload();
      }),
  };

  // Visible rows = filter → search → sort; visible columns = minus hidden.
  // Cell coordinates (r, c) index these two arrays everywhere below.
  const cols = view.layout === "table" ? props.filter((p) => !view.hidden.includes(p.id)) : props;
  const sorted = applySort(searchRecords(applyFilter(records, props, view.filter), props, query), props, sort);
  const pickRefs: PickRefs = (anchor, prop, current, onPick) => {
    if (prop.type === "doc") openDocMenu(anchor, current, (v) => onPick(Array.isArray(v) ? (v as string[]) : []));
    else openRelationMenu(anchor, prop, current, (v) => onPick(Array.isArray(v) ? (v as string[]) : []));
  };

  const peekRec = records.find((r) => r.id === peek) ?? null;
  const cr = cellSel ? normRect(cellSel) : null;

  // Keyboard on the cell selection: arrows move (Shift extends), Cmd/Ctrl+C copies,
  // Delete/Backspace clears, Escape dismisses, Enter/F2 edits, and typing a
  // printable character starts editing with it (replacing the old value).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || e.defaultPrevented || imeGhost(e)) return;
      if (isEditableTarget(document.activeElement)) return;
      if (pressed(e, "tableUndo")) { e.preventDefault(); undoCells(); return; }
      if (pressed(e, "tableRedo")) { e.preventDefault(); redoCells(); return; }
      if (peek && (e.metaKey || e.ctrlKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const i = sorted.findIndex((r) => r.id === peek);
        const nb = sorted[i + (e.key === "ArrowUp" ? -1 : 1)];
        if (nb) { e.preventDefault(); openPeek(nb.id); }
        return;
      }
      if (!cellSel) return;
      const single = cellSel.a.r === cellSel.b.r && cellSel.a.c === cellSel.b.c;
      const { r, c } = cellSel.b;
      const rect = normRect(cellSel);
      const ARROWS: Record<string, [number, number]> = {
        ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
      };
      if (e.key in ARROWS) {
        e.preventDefault();
        const [dr, dc] = ARROWS[e.key]!;
        const far = e.metaKey || e.ctrlKey;
        const b = far
          ? { r: dr ? (dr < 0 ? 0 : sorted.length - 1) : r, c: dc ? (dc < 0 ? 0 : cols.length - 1) : c }
          : { r: clampN(r + dr, 0, sorted.length - 1), c: clampN(c + dc, 0, cols.length - 1) };
        setCellSel(e.shiftKey ? { a: cellSel.a, b } : { a: b, b });
        scrollCellIntoView(b.r, b.c);
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        const b = { r, c: e.key === "Home" ? 0 : cols.length - 1 };
        setCellSel(e.shiftKey ? { a: cellSel.a, b } : { a: b, b });
        scrollCellIntoView(b.r, b.c);
      } else if (pressed(e, "tableCopy")) {
        e.preventDefault();
        copySelection();
      } else if (pressed(e, "tableSelectAll")) {
        e.preventDefault();
        if (sorted.length && cols.length) setCellSel({ a: { r: 0, c: 0 }, b: { r: sorted.length - 1, c: cols.length - 1 } });
      } else if (pressed(e, "tableOpen")) {
        e.preventDefault();
        if (sorted[r]) openPeek(sorted[r].id);
      } else if (pressed(e, "tableSelectRow")) {
        e.preventDefault();
        setSel(new Set(sorted.slice(rect.r0, rect.r1 + 1).map((x) => x.id)));
        setCellSel(null);
      } else if (pressed(e, "tableDuplicate")) {
        e.preventDefault();
        for (const rec of sorted.slice(rect.r0, rect.r1 + 1)) duplicateRecord(rec);
      } else if (e.key === "Escape") {
        setCellSel(null);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        applyToSelection(() => null);
      } else if (single && (e.key === "Enter" || e.key === "F2" || (e.key === " " && cols[c]?.type === "checkbox"))) {
        e.preventDefault();
        activateCell(r, c);
      } else if (single && e.key === " ") {
        e.preventDefault();
        if (sorted[r]) openPeek(sorted[r].id);
      } else if (single && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Type-to-edit. Known limit: an IME composition's first key (keyCode 229)
        // can't seed the editor — enter editing via Enter / click first.
        const p = cols[c];
        if (!p || p.type === "checkbox") return;
        if (p.type === "number" && !/[0-9.+-]/.test(e.key)) return;
        if (p.type === "date" && !/[0-9]/.test(e.key)) return;
        e.preventDefault();
        activateCell(r, c, e.key);
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!cellSel || editing || isEditableTarget(document.activeElement)) return;
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      const grid = parseGrid(text);
      if (!grid.length) return;
      const rect = normRect(cellSel);
      const one = grid.length === 1 && grid[0]!.length === 1;
      const target = one ? rect : { r0: rect.r0, r1: rect.r0 + grid.length - 1, c0: rect.c0, c1: rect.c0 + Math.max(...grid.map((g) => g.length)) - 1 };
      const tiled = one
        ? Array.from({ length: target.r1 - target.r0 + 1 }, () => Array.from({ length: target.c1 - target.c0 + 1 }, () => grid[0]![0]!))
        : grid;
      const { patches, skipped } = pastePatches(tiled, sorted, cols, target.r0, target.c0);
      void applyCells(patches);
      const r1 = clampN(target.r1, 0, sorted.length - 1), c1 = clampN(target.c1, 0, cols.length - 1);
      setCellSel({ a: { r: target.r0, c: target.c0 }, b: { r: r1, c: c1 } });
      if (skipped) toast(t("{n} 个单元格因类型不匹配未写入", { n: skipped }));
    };
    addEventListener("keydown", onKey);
    document.addEventListener("paste", onPaste);
    return () => {
      removeEventListener("keydown", onKey);
      document.removeEventListener("paste", onPaste);
    };
  }, [cellSel, editing, records, props, view, query, sel, peek]);

  return (
    <div
      class="db"
      onPointerDown={(e) => {
        if (!(e.target as HTMLElement).closest("td.cell-td, .cellselbar, .peek, .scrim, .selbar")) setCellSel(null);
      }}
    >
      <div class="db-head">
        <div class="db-icon">{db.icon || "🗂️"}</div>
        <div>
          <div
            class="db-title"
            contentEditable
            {...plainPasteHandlers()}
            onKeyDown={(e) => {
              if (imeGhost(e)) return;
              const el = e.target as HTMLElement;
              if (e.key === "Enter") { e.preventDefault(); el.blur(); }
              else if (e.key === "Escape") { e.preventDefault(); el.textContent = db.name; el.blur(); }
            }}
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
            title={t("已分享 · 管理分享")}
            onClick={() => openShareModal({ kind: "database", ref: db.id, title: db.name })}
          >
            <Icon name="link" />
          </span>
        )}
      </div>

      <ViewTabs
        views={views}
        activeId={view.id}
        onSelect={selectView}
        onCreate={createView}
        onRename={(id, name) => updateView({ name }, id)}
        onDuplicate={duplicateView}
        onDelete={deleteView}
      >
        <button class="btn btn-primary" onClick={newRecord}><Icon name="plus" cls="ico sm" />{t("新建")}</button>
      </ViewTabs>

      <ViewToolbar
        props={props}
        view={view}
        onChange={(patch) => updateView(patch)}
        onReorder={persistColumnMove}
        pickRefs={pickRefs}
        query={query}
        onQuery={setQuery}
      >
        {view.layout !== "board" && <PopOutBoard dbId={db.id} />}
      </ViewToolbar>
      <ChipRow props={props} view={view} onChange={(patch) => updateView(patch)} pickRefs={pickRefs} />

      {view.layout === "board" ? (
        <BoardView
          props={props}
          records={sorted}
          onCommitValue={commit}
          onCreate={createRecordWith}
          onOpenRecord={openPeek}
          onMove={persistRecordMove}
          group={view.group ?? null}
          onGroupChange={(id) => updateView({ group: id })}
          barExtra={<PopOutBoard dbId={db.id} />}
        />
      ) : view.layout === "calendar" ? (
        <CalendarView
          props={props}
          records={sorted}
          onCommitValue={commit}
          onCreate={createRecordWith}
          onOpenRecord={openPeek}
          dateField={view.dateProp ?? null}
          onDateFieldChange={(id) => updateView({ dateProp: id })}
        />
      ) : view.layout === "timeline" ? (
        <TimelineView
          props={props}
          records={sorted}
          onCommitValue={commit}
          onCreate={createRecordWith}
          onOpenRecord={openPeek}
          startField={view.start ?? null}
          endField={view.end === null ? "none" : (view.end ?? null)}
          onFieldsChange={(f) => updateView({ ...(f.start ? { start: f.start } : {}), ...(f.end !== undefined ? { end: f.end === "none" ? null : f.end } : {}) })}
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
              class={"rowgrip-ext" + (sorting ? " is-disabled" : "")}
              style={{ top: grip.top + grip.height / 2 }}
              title={sorting ? t("清除排序后可拖拽移动") : t("拖拽移动")}
              aria-disabled={sorting ? "true" : undefined}
              onPointerDown={(e) => startRowDrag(e, grip.id)}
            >
              <Icon name="grip" cls="ico sm" />
            </button>
          )}
          {dropY != null && <div class="rowdrop" style={{ top: dropY }} />}
          <div class="tablewrap">
          <div class="tablescroll">
            {!loaded ? (
              <table class="grid skel skel-list" aria-busy="true">
                <colgroup>
                  <col style={{ width: 38 }} />
                  {[0, 1, 2, 3].map((i) => <col key={i} style={{ width: i === 0 ? 240 : 150 }} />)}
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th class="selcell" />
                    {[0, 1, 2, 3].map((i) => <th key={i}><div class="colhead"><span class="skel-b skel-t" style={`--i:${i}`} /></div></th>)}
                    <th class="addcol" />
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: skelRows }, (_, r) => (
                    <tr key={r}>
                      <td class="selcell" />
                      {[0, 1, 2, 3].map((i) => <td key={i} class="cell-td"><div class="cell"><span class="skel-b skel-t" style={`--i:${(r + i) % 5}`} /></div></td>)}
                      <td class="filler" />
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
            <table class={"grid" + (view.wrap === false ? " nowrap" : "")} ref={tableRef}>
              <colgroup>
                <col style={{ width: 38 }} />
                {cols.map((p) => (
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
                      onChange={(e) => {
                        setSel((e.target as HTMLInputElement).checked ? new Set(records.map((r) => r.id)) : new Set());
                        setCellSel(null);
                      }}
                    />
                  </th>
                  {cols.map((p) => {
                    const sr = sort.find((x) => x.prop === p.id);
                    return (
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
                          openColMenu(e, p, db.id, reload, props, colMenuCtx);
                        }}
                      >
                        <span class="ti"><Icon name={TYPE_ICON[p.type] ?? "text"} cls="ico sm" /></span>
                        <span class="nm">{p.name}</span>
                        {sr && <Icon name="arrowUp" cls={"ico sm sortmark" + (sr.desc ? " flipv" : "")} />}
                        <Icon name="chevronDown" cls="ico sm caret" />
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
                    );
                  })}
                  <th class="addcol">
                    <div class="colhead" title={t("新建属性")} onClick={(e) => openAddCol(e, db.id, props, reload)}>
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
                        onClick={(e) => toggleRow(rec.id, e.shiftKey)}
                      />
                    </td>
                    {cols.map((p, ci) => {
                      const inSel = cr != null && ri >= cr.r0 && ri <= cr.r1 && ci >= cr.c0 && ci <= cr.c1;
                      const inFill = cr != null && fillTo != null && ri > cr.r1 && ri <= fillTo && ci >= cr.c0 && ci <= cr.c1;
                      const boxShadow = cr ? edgeShadow(cr, ri, ci) : undefined;
                      const corner = cr != null && ri === cr.r1 && ci === cr.c1;
                      return (
                        <td
                          key={p.id}
                          class={"cell-td" + (inSel ? " cellsel" : "") + (inFill ? " fillsel" : "")}
                          data-r={ri}
                          data-c={ci}
                          style={boxShadow ? { boxShadow } : undefined}
                          onPointerDown={(e) => startCellSelect(e, ri, ci)}
                        >
                          {corner && <div class="cell-fill-handle" onPointerDown={startFill} />}
                          <CellView
                            rec={rec}
                            prop={p}
                            first={ci === 0}
                            editing={editing?.rec === rec.id && editing?.prop === p.id}
                            seed={editing?.rec === rec.id && editing?.prop === p.id ? editing.seed : undefined}
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
                            onRowMenu={(e) => openRowMenu(e, rec, () => openPeek(rec.id), () => duplicateRecord(rec), () => deleteRecords([rec.id]))}
                          />
                        </td>
                      );
                    })}
                    <td class="filler" />
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td class="selcell" />
                  {cols.map((p) => {
                    const kind = view.calc?.[p.id];
                    return (
                      <td key={p.id} class={"calc" + (kind ? " on" : "")} onClick={(e) => openCalcMenu(e, p, kind, (k) => {
                        const calc = { ...(view.calc ?? {}) };
                        if (k) calc[p.id] = k; else delete calc[p.id];
                        updateView({ calc });
                      })}>
                        {kind ? (
                          <><span class="k">{calcLabel(kind)}</span><span class="v">{computeCalc(kind, p, sorted.map((r) => r.cells[p.id]))}</span></>
                        ) : (
                          <span class="k ghost">{t("计算")}<Icon name="chevronDown" cls="ico sm" /></span>
                        )}
                      </td>
                    );
                  })}
                  <td class="filler" />
                </tr>
              </tfoot>
            </table>
            )}
          </div>
          {loaded && sorted.length === 0 && records.length === 0 && (
            <div class="site-empty tbl-empty">
              <div class="ei"><Icon name="table" /></div>
              <div class="et">{t("还没有记录")}</div>
              <div class="ed">{t("新建一条记录，或从 CLI 导入。")}</div>
              <button class="btn btn-primary" onClick={newRecord}>
                <Icon name="plus" cls="ico sm" />
                {t("新建记录")}
              </button>
            </div>
          )}
          {loaded && sorted.length === 0 && records.length > 0 && (
            <div class="site-empty tbl-empty">
              <div class="ei"><Icon name="filter" /></div>
              <div class="et">{t("没有符合条件的记录")}</div>
              <div class="ed">{query ? t("换个关键词，或清除筛选条件。") : t("调整或清除筛选条件后会再次显示记录。")}</div>
              <button class="btn btn-secondary" onClick={() => { setQuery(""); updateView({ filter: { op: "and", rules: [] } }); }}>
                {t("清除筛选")}
              </button>
            </div>
          )}
          <div class="addrow" onClick={newRecord}><Icon name="plus" cls="ico sm" />{t("新建记录")}</div>
          </div>
        </div>
      )}

      <div class="gridfoot">
        <span>{sorted.length === records.length ? t("共 {n} 条记录", { n: records.length }) : t("显示 {m} / {n} 条记录", { m: sorted.length, n: records.length })}</span>
        {view.layout === "table" && cols.length < props.length && <span>{t("{n} 列已隐藏", { n: props.length - cols.length })}</span>}
      </div>

      {sel.size > 0 && (
        <div class="selbar">
          <span class="cnt">{t("{n} 已选", { n: sel.size })}</span>
          {sel.size === 1 && (
            <button onClick={() => openPeek([...sel][0]!)}><Icon name="openPeek" cls="ico sm" />{t("打开")}</button>
          )}
          <button onClick={(e) => openSetPropMenu(e, [...sel])}><Icon name="pencil" cls="ico sm" />{t("设置属性…")}</button>
          <button onClick={() => guard(async () => { for (const id of sel) await duplicateRecord(records.find((r) => r.id === id)!); })}>
            <Icon name="copy" cls="ico sm" />{t("复制")}
          </button>
          <button class="del" onClick={async () => {
            const ok = await confirmDialog({ title: t("删除记录？"), message: t("确定删除选中的 {n} 条记录？", { n: sel.size }), confirmLabel: t("删除"), danger: true });
            if (ok) deleteRecords([...sel]);
          }}>
            <Icon name="trash" cls="ico sm" />{t("删除")}
          </button>
          <button onClick={() => setSel(new Set())}><Icon name="x" cls="ico sm" /></button>
        </div>
      )}

      {cr && (cr.r0 !== cr.r1 || cr.c0 !== cr.c1) && (
        <div class="selbar cellselbar">
          <span class="cnt">{t("{n} 个单元格", { n: (cr.r1 - cr.r0 + 1) * (cr.c1 - cr.c0 + 1) })}</span>
          <button onClick={copySelection}><Icon name="copy" cls="ico sm" />{t("复制")}</button>
          <button onClick={() => applyToSelection((p) => sorted[cr.r0]!.cells[p.id] ?? null)}>
            <Icon name="copy" cls="ico sm" />{t("填充")}
          </button>
          <button class="del" onClick={() => applyToSelection(() => null)}>
            <Icon name="trash" cls="ico sm" />{t("清空")}
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
          hidden={view.hidden}
          prevId={sorted[sorted.findIndex((r) => r.id === peekRec.id) - 1]?.id ?? null}
          nextId={sorted[sorted.findIndex((r) => r.id === peekRec.id) + 1]?.id ?? null}
          onNavigate={openPeek}
        />
      )}
    </div>
  );
}

type CellEdit = { recId: string; propId: string; before: unknown; after: unknown };

// ---- cell ----
/** How an editing session ended: cancel discards; every other reason carries
 *  the coerced value plus whether it differs from what the editor opened with —
 *  callers skip the API call (and the history entry) when nothing changed. */
type EditEnd =
  | { reason: "cancel" }
  | { reason: "blur" | "enter" | "tab" | "shifttab"; changed: boolean; value: unknown };

/** Single-field inline editor for text/number/url values. Shared by the grid
 *  cells and the record peek panel. Text grows with its content (Shift+Enter
 *  for a newline); date/select/relation/doc edit through their pickers.
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
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const done = useRef(false);
  const multiline = prop.type === "text";
  const grow = () => {
    const el = ref.current;
    if (!el || !multiline) return;
    el.style.height = "0";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => {
    const el = ref.current!;
    el.value = seed ?? initial;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    grow();
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
  const onKeyDown = (e: KeyboardEvent) => {
    if (imeGhost(e)) return;
    if (e.key === "Enter" && !(multiline && e.shiftKey)) { e.preventDefault(); finish("enter"); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish("cancel"); }
    else if (e.key === "Tab" && captureTab) { e.preventDefault(); finish(e.shiftKey ? "shifttab" : "tab"); }
  };
  if (multiline) {
    return (
      <textarea
        ref={ref as any}
        class="inlineedit"
        rows={1}
        onInput={grow}
        onBlur={() => finish("blur")}
        onKeyDown={onKeyDown}
      />
    );
  }
  return (
    <input
      ref={ref as any}
      class={"inlineedit" + (prop.type === "number" ? " num" : "")}
      type="text"
      inputMode={prop.type === "number" ? "decimal" : prop.type === "url" ? "url" : "text"}
      onBlur={() => finish("blur")}
      onKeyDown={onKeyDown}
    />
  );
}

function CellView({
  rec, prop, first, editing, seed, onCommit, onDone, onOpen, onRowMenu,
}: {
  rec: Rec; prop: Prop; first: boolean; editing: boolean; seed?: string;
  onCommit: (v: unknown) => void; onDone: (end: EditEnd) => void;
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

  // Click/keyboard activation is owned by the <td> (DatabaseView.activateCell).
  const body = <CellDisplay prop={prop} val={val} />;
  const cls = "cell" + (prop.type === "number" ? " num" : "");
  const display = first ? (
    <div class={cls} onContextMenu={(e) => { e.preventDefault(); onRowMenu(e); }}>
      <div class="firstcell">
        {body}
        <div class="rowactions">
          <button class="rowopen" {...tip(t("打开"))} onClick={(e) => { e.stopPropagation(); onOpen(); }}>
            <Icon name="openPeek" cls="ico sm" />
          </button>
        </div>
      </div>
    </div>
  ) : (
    <div class={cls}>{body}</div>
  );

  // The editor overlays the td (.celledit is absolute over the relative cell-td)
  // while the display content stays in flow — the row height never changes.
  return (
    <>
      {display}
      {editing && (
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
  return text || t("移动记录");
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
function openSelectMenu(anchor: MenuAnchor, prop: Prop, val: unknown, onCommit: (v: unknown) => void, seed?: string) {
  if (anchor instanceof MouseEvent) anchor.stopPropagation();
  const multi = prop.type === "multi_select";
  const options = prop.config?.options ?? [];
  openMenu(anchor, (close) => (
    <SelectMenu
      multi={multi}
      options={options}
      value={val}
      prop={prop}
      seed={seed}
      onPick={(v) => { onCommit(v); if (!multi) close(); }}
    />
  ), { minWidth: 220 });
}
function SelectMenu({ multi, options, value, onPick, prop, seed }: { multi: boolean; options: string[]; value: unknown; onPick: (v: unknown) => void; prop: Prop; seed?: string }) {
  const [opts, setOpts] = useState<string[]>(options);
  const [cur, setCur] = useState<unknown>(value);
  const [query, setQuery] = useState(seed ?? "");
  const [selIdx, setSelIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim();
  const filtered = rankMatches(q, opts, (o) => o).map((r) => r.item);
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
      .catch((e) => toast(t("创建选项失败：{msg}", { msg: (e as Error).message })));
  };
  const activate = (i: number) => { if (i < filtered.length) pick(filtered[i]!); else create(); };

  return (
    <>
      <div class="selsearch">
        <Icon name="search" cls="ico sm" />
        <input
          placeholder={t("搜索或创建选项")}
          value={query}
          ref={(el) => { if (el && document.activeElement !== el) el.focus(); }}
          onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setSelIdx(0); }}
          onKeyDown={(e) => {
            if (imeGhost(e)) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setSelIdx(Math.min(sel + 1, rowCount - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSelIdx(Math.max(sel - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); activate(sel); }
            else if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
          }}
        />
        <ClearQuery query={query} onClear={() => { setQuery(""); setSelIdx(0); }} />
      </div>
      <div ref={listRef} class="rellist">
        {filtered.map((o, i) => (
          <button key={o} class={"item" + (i === sel ? " sel" : "")} onClick={() => pick(o)} onMouseEnter={() => setSelIdx(i)}>
            <Chip text={o} />
            {isOn(o) ? <span class="chk"><Icon name="check" cls="ico sm" /></span> : <ReturnHint />}
          </button>
        ))}
        {!filtered.length && !canCreate && <div class="pal-empty">{opts.length ? t("没有匹配的选项") : t("还没有选项，输入名称创建")}</div>}
        {canCreate && (
          <button
            class={"item" + (sel === filtered.length ? " sel" : "")}
            onClick={create}
            onMouseEnter={() => setSelIdx(filtered.length)}
          >
            <span class="lico plain"><Icon name="plus" cls="ico sm" /></span>
            {t("创建")}
            <Chip text={q} />
          </button>
        )}
      </div>
      {multi && Array.isArray(cur) && cur.length > 0 && (
        <>
          <MenuSep />
          <MenuItem icon="x" label={t("清空")} onClick={() => { setCur([]); onPick([]); }} />
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
  const ranked = rankMatches(q, all, (r) => r.title ?? "");
  const matches = ranked.map((r) => r.item);
  const CAP = 50;
  const shown = ranked.slice(0, CAP);
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
      .catch((e) => toast(t("创建记录失败：{msg}", { msg: (e as Error).message })));
  };
  const activate = (i: number) => { if (i < shown.length) pick(shown[i]!.item.id); else create(); };

  return (
    <>
      <div class="selsearch">
        <Icon name="search" cls="ico sm" />
        <input
          placeholder={t("搜索或创建记录")}
          value={query}
          ref={(el) => { if (el && document.activeElement !== el) el.focus(); }}
          onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setSelIdx(0); }}
          onKeyDown={(e) => {
            if (imeGhost(e)) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setSelIdx(Math.min(sel + 1, rowCount - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSelIdx(Math.max(sel - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); activate(sel); }
            else if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
          }}
        />
        <ClearQuery query={query} onClear={() => { setQuery(""); setSelIdx(0); }} />
      </div>
      <div ref={listRef} class="rellist">
        {!target && <div class="pal-empty">{t("该属性未设置关联目标")}</div>}
        {target && state === "error" && <div class="pal-empty">{t("无法加载目标数据表")}</div>}
        {target && state !== "loading" && state !== "error" && all.length === 0 && (
          <div class="pal-empty">{t("目标数据表暂无记录")}</div>
        )}
        {target && state !== "error" && all.length > 0 && !shown.length && !canCreate && (
          <div class="pal-empty">{t("没有匹配的记录")}</div>
        )}
        {shown.map(({ item: r }, i) => (
          <button key={r.id} class={"item" + (i === sel ? " sel" : "")} onClick={() => pick(r.id)} onMouseEnter={() => setSelIdx(i)}>
            <Chip text={relationLabel(target, r.id)} />
            {cur.includes(r.id) ? <span class="chk"><Icon name="check" cls="ico sm" /></span> : <ReturnHint />}
          </button>
        ))}
        {matches.length > CAP && <MenuLabel>{t("还有 {n} 条，继续输入过滤", { n: matches.length - CAP })}</MenuLabel>}
        {canCreate && (
          <button
            class={"item" + (sel === shown.length ? " sel" : "")}
            onClick={create}
            onMouseEnter={() => setSelIdx(shown.length)}
          >
            <span class="lico plain"><Icon name="plus" cls="ico sm" /></span>
            {t("创建")}
            <Chip text={q} />
          </button>
        )}
      </div>
      {cur.length > 0 && (
        <>
          <MenuSep />
          <MenuItem icon="x" label={t("清空")} onClick={() => { setCur([]); onPick([]); }} />
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
  const ranked = rankMatches(q, all, (d) => d.title);
  const matches = ranked.map((r) => r.item);
  const CAP = 50;
  const shown = ranked.slice(0, CAP);
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
      .catch((e) => toast(t("创建文档失败：{msg}", { msg: (e as Error).message })));
  };
  const activate = (i: number) => { if (i < shown.length) pick(shown[i]!.item.id); else create(); };

  return (
    <>
      <div class="selsearch">
        <Icon name="search" cls="ico sm" />
        <input
          placeholder={t("搜索或创建文档")}
          value={query}
          ref={(el) => { if (el && document.activeElement !== el) el.focus(); }}
          onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setSelIdx(0); }}
          onKeyDown={(e) => {
            if (imeGhost(e)) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setSelIdx(Math.min(sel + 1, rowCount - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSelIdx(Math.max(sel - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); activate(sel); }
            else if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
          }}
        />
        <ClearQuery query={query} onClear={() => { setQuery(""); setSelIdx(0); }} />
      </div>
      <div ref={listRef} class="rellist">
        {all.length === 0 && !canCreate && <div class="pal-empty">{t("暂无文档，输入标题创建")}</div>}
        {all.length > 0 && !shown.length && <div class="pal-empty">{t("没有匹配的文档")}</div>}
        {shown.map(({ item: d, start, len }, i) => {
          const where = docParentChain(d.id).join(" › ");
          return (
            <button key={d.id} class={"item sub-r" + (i === sel ? " sel" : "")} onClick={() => pick(d.id)} onMouseEnter={() => setSelIdx(i)}>
              <span class="lico plain"><Icon name="fileText" cls="ico sm" /></span>
              <span class="meta">
                <span class="t">{d.title ? <Highlight text={d.title} span={start >= 0 ? [start, len] : undefined} /> : t("无标题")}</span>
                {where && <span class="d">{where}</span>}
              </span>
              {cur.includes(d.id) ? <span class="chk"><Icon name="check" cls="ico sm" /></span> : <ReturnHint />}
            </button>
          );
        })}
        {matches.length > CAP && <MenuLabel>{t("还有 {n} 条，继续输入过滤", { n: matches.length - CAP })}</MenuLabel>}
        {canCreate && (
          <button
            class={"item" + (sel === shown.length ? " sel" : "")}
            onClick={create}
            onMouseEnter={() => setSelIdx(shown.length)}
          >
            <span class="lico plain"><Icon name="plus" cls="ico sm" /></span>
            {t("创建")}
            <Chip text={q} />
          </button>
        )}
      </div>
      {cur.length > 0 && (
        <>
          <MenuSep />
          <MenuItem icon="x" label={t("清空")} onClick={() => { setCur([]); onPick([]); }} />
        </>
      )}
    </>
  );
}

// ---- column header menu ----
/** What the column header menu needs from the page: the view (sort/hide/wrap),
 *  the records (to count cells a type change would clear) and the insert/
 *  duplicate actions that touch positions. */
type ColMenuCtx = {
  view: ViewDef;
  records: Rec[];
  setSort: (propId: string, desc: boolean | null) => void;
  addFilter: (prop: Prop, anchor: MenuAnchor) => void;
  hide: (propId: string) => void;
  toggleWrap: () => void;
  insert: (prop: Prop, where: DropWhere, anchor: MenuAnchor) => void;
  duplicate: (prop: Prop) => void;
};
function openColMenu(e: MouseEvent, prop: Prop, dbId: string, reload: () => Promise<void>, allProps: Prop[], ctx: ColMenuCtx) {
  e.stopPropagation();
  const anchor: MenuAnchor = { rect: (e.currentTarget as HTMLElement).getBoundingClientRect() };
  openMenu(e, (close) => <ColMenu prop={prop} dbId={dbId} reload={reload} close={close} allProps={allProps} ctx={ctx} anchor={anchor} />, { minWidth: 252 });
}
function ColMenu({ prop, dbId, reload, close, allProps, ctx, anchor }: { prop: Prop; dbId: string; reload: () => Promise<void>; close: () => void; allProps: Prop[]; ctx: ColMenuCtx; anchor: MenuAnchor }) {
  const [step, setStep] = useState<"main" | "type">("main");
  const [name, setName] = useState(prop.name);
  const [type, setType] = useState<PropType>(prop.type);
  const [options, setOptions] = useState<string[]>(prop.config?.options ?? []);
  const [target, setTarget] = useState<string | undefined>(prop.config?.database);
  const [editing, setEditing] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null); // only one row edits at a time

  const persist = (patch: { name?: string; type?: PropType; config?: PropConfig }) =>
    api.updateProperty(prop.id, patch).then(reload).catch((e) => toast(t("更新属性失败：{msg}", { msg: (e as Error).message })));

  const filledCells = ctx.records.filter((r) => {
    const v = r.cells[prop.id];
    return !(v == null || v === "" || (Array.isArray(v) && v.length === 0));
  }).length;
  const changeType = async (pt: PropType) => {
    if (pt === type) return;
    if (filledCells > 0) {
      const ok = await confirmDialog({
        title: t("更改属性类型？"),
        message: t("改为「{type}」会清空这一列的 {n} 个单元格，可在版本历史中回滚。", { type: TYPE_META[pt].t, n: filledCells }),
        confirmLabel: t("更改"),
        danger: true,
        aboveMenus: true,
      });
      if (!ok) return;
    }
    setType(pt);
    if (pt === "relation") {
      // relation is only valid with a target database — without one, defer the
      // persist to the target list below; with one (kept in config through
      // type flips — config is a merge patch), re-attach it explicitly since
      // the type change re-validates.
      if (target) persist({ type: pt, config: { database: target } });
      return;
    }
    let opts = options;
    if ((pt === "select" || pt === "multi_select") && opts.length === 0) {
      opts = [t("选项 1"), t("选项 2")];
      setOptions(opts);
    }
    persist({ type: pt, ...(pt === "select" || pt === "multi_select" ? { config: { options: opts } } : {}) });
  };
  const setOpts = (next: string[]) => { setOptions(next); persist({ config: { options: next } }); };

  // Renames go through the dedicated cascade op — the server rewrites every
  // cell holding the old string, so existing records follow the new name.
  const renameOpt = (from: string, raw: string) => {
    setEditing(null);
    const to = raw.trim();
    if (!to || to === from) return;
    if (options.includes(to)) { toast(t("已存在同名选项")); return; }
    const prev = options;
    setOptions(prev.map((o) => (o === from ? to : o)));
    api.renameSelectOption(prop.id, from, to).then(reload).catch((e) => {
      setOptions(prev);
      toast(t("重命名选项失败：{msg}", { msg: (e as Error).message }));
    });
  };

  const removeOpt = async (o: string) => {
    if (options.length === 1) { toast(t("至少保留一个选项")); return; }
    // aboveMenus stacks the dialog over this popover, so the menu survives it
    const ok = await confirmDialog({ title: t("删除选项？"), message: t("「{name}」将从所有使用它的记录中清除。", { name: o }), confirmLabel: t("删除"), danger: true, aboveMenus: true });
    if (!ok) return;
    const prev = options;
    setOptions(prev.filter((x) => x !== o));
    api.removeSelectOption(prop.id, o).then(reload).catch((e) => {
      setOptions(prev);
      toast(t("删除选项失败：{msg}", { msg: (e as Error).message }));
    });
  };

  const addOpt = (input: HTMLInputElement) => {
    const v = input.value.trim();
    if (!v) return;
    if (options.includes(v)) { toast(t("已存在同名选项")); return; }
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

  const sr = ctx.view.sort.find((x) => x.prop === prop.id);
  const isTitle = allProps[0]?.id === prop.id;
  if (step === "main") {
    return (
      <>
        <input
          class="field"
          value={name}
          ref={(el) => { if (el && document.activeElement !== el && !el.dataset.touched) { el.dataset.touched = "1"; el.focus(); el.select(); } }}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          onBlur={() => name && name !== prop.name && persist({ name })}
          onKeyDown={(e) => { if (imeGhost(e)) return; if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); close(); } }}
        />
        <MenuItem icon={TYPE_ICON[type]} label={t("类型")} sublabel={TYPE_META[type].t} sub="right" onClick={() => setStep("type")} />
        <MenuSep />
        <MenuItem icon="arrowUp" label={t("升序")} checked={!!sr && !sr.desc} onClick={() => { close(); ctx.setSort(prop.id, sr && !sr.desc ? null : false); }} />
        <MenuItem icon="arrowDown" label={t("降序")} checked={!!sr && sr.desc} onClick={() => { close(); ctx.setSort(prop.id, sr && sr.desc ? null : true); }} />
        <MenuItem icon="filter" label={t("筛选此列")} onClick={() => { close(); ctx.addFilter(prop, anchor); }} />
        {!isTitle && <MenuItem icon="eyeOff" label={t("隐藏")} onClick={() => { close(); ctx.hide(prop.id); }} />}
        <MenuSep />
        <MenuItem icon="arrowLeft" label={t("左侧插入列")} onClick={() => { close(); ctx.insert(prop, "before", anchor); }} />
        <MenuItem icon="arrowRight" label={t("右侧插入列")} onClick={() => { close(); ctx.insert(prop, "after", anchor); }} />
        <MenuItem icon="copy" label={t("复制列")} onClick={() => { close(); ctx.duplicate(prop); }} />
        <MenuItem icon="wrapText" label={t("换行文本")} checked={ctx.view.wrap !== false} onClick={() => { close(); ctx.toggleWrap(); }} />
        <MenuSep />
        <MenuItem icon="trash" label={t("删除属性")} danger onClick={async () => {
          close();
          const ok = await confirmDialog({ title: t("删除属性？"), message: t("「{name}」及其所有单元格数据将被移除。", { name: prop.name }), confirmLabel: t("删除"), danger: true });
          if (ok) api.deleteProperty(prop.id).then(reload).catch((e) => toast(t("更新属性失败：{msg}", { msg: (e as Error).message })));
        }} />
      </>
    );
  }
  return (
    <>
      <MenuItem icon="arrowLeft" label={t("返回")} sublabel={prop.name} sub="right" onClick={() => setStep("main")} />
      <MenuSep />
      <MenuLabel>{t("属性类型")}</MenuLabel>
      <div class="typegrid">
        {(Object.keys(TYPE_META) as PropType[]).map((pt) => (
          <button key={pt} class={"item" + (pt === type ? " sel" : "")} onClick={() => changeType(pt)}>
            <span class="lico"><Icon name={TYPE_ICON[pt]!} cls="ico sm" /></span>
            <span class="d">{TYPE_META[pt].t}</span>
          </button>
        ))}
      </div>
      {(type === "select" || type === "multi_select") && (
        <>
          <MenuSep />
          <MenuLabel>{t("选项")}</MenuLabel>
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
                    class="x ok" {...tip(t("确认"))}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => editRef.current?.blur()}
                  ><Icon name="check" cls="ico sm" /></button>
                  <button
                    class="x cancel" {...tip(t("取消"))}
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
                  <button class="optlabel" {...tip(t("重命名选项"))} onClick={() => setEditing(o)}><Chip text={o} /></button>
                  <button class="x" {...tip(t("重命名选项"))} onClick={() => setEditing(o)}><Icon name="pencil" cls="ico sm" /></button>
                  <button class="x del" {...tip(t("删除选项"))} onClick={() => removeOpt(o)}><Icon name="x" cls="ico sm" /></button>
                </>
              )}
            </div>
          ))}
          <div class="optrow optadd">
            <span class="grip dim"><Icon name="plus" cls="ico sm" /></span>
            <input
              placeholder={t("添加选项")}
              onKeyDown={(e) => { if (e.key === "Enter") addOpt(e.target as HTMLInputElement); }}
            />
          </div>
        </>
      )}
      {type === "relation" && (
        <>
          <MenuSep />
          <MenuLabel>{target ? t("关联目标") : t("选择关联的数据表")}</MenuLabel>
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

/** Searchable database list for pick-a-database menus: relation targets here,
 *  the quick board's switcher (quickboard.tsx). Every database is listed —
 *  self-relation is legal, so the current table appears too, just labeled. */
export function DbTargetList({ currentDb, target, autoFocus, placeholder = t("搜索数据表"), databases, onPick }: {
  /** labels the matching row 「当前表」 (relation pickers — self-relation cue) */
  currentDb?: string; target?: string;
  /** steal focus only in the dedicated pick step — ColMenu has a rename input on top */
  autoFocus?: boolean;
  placeholder?: string;
  /** Caller-held list (skips the fetch). */
  databases?: Db[];
  onPick: (d: Db) => void;
}) {
  const [fetched, setFetched] = useState<Db[] | null>(null);
  const [query, setQuery] = useState("");
  const [selIdx, setSelIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (databases) return;
    api.listDatabases().then(setFetched).catch(() => setFetched([]));
  }, [!!databases]);
  const dbs = databases ?? fetched;

  const q = query.trim().toLowerCase();
  const all = dbs ?? [];
  const ranked = rankMatches(q, all, (d) => d.name || t("未命名数据库"));
  const matches = ranked.map((r) => r.item);
  const CAP = 50;
  const shown = ranked.slice(0, CAP);
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
          placeholder={placeholder}
          value={query}
          ref={autoFocus ? (el) => { if (el && document.activeElement !== el) el.focus(); } : undefined}
          onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setSelIdx(0); }}
          onKeyDown={(e) => {
            if (imeGhost(e)) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setSelIdx(Math.min(sel + 1, shown.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSelIdx(Math.max(sel - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); if (shown[sel]) onPick(shown[sel].item); }
            else if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
          }}
        />
        <ClearQuery query={query} onClear={() => { setQuery(""); setSelIdx(0); }} />
      </div>
      <div ref={listRef} class="rellist">
        {shown.length === 0 && <div class="pal-empty">{all.length ? t("没有匹配的数据表") : t("还没有数据库")}</div>}
        {shown.map(({ item: d, start, len }, i) => (
          <button key={d.id} class={"item sub-r" + (i === sel ? " sel" : "")} onClick={() => onPick(d)} onMouseEnter={() => setSelIdx(i)}>
            <span class="lico plain"><span class="emo">{d.icon || "🗂️"}</span></span>
            <span class="meta">
              <span class="t"><Highlight text={d.name || t("未命名数据库")} span={start >= 0 ? [start, len] : undefined} /></span>
              {d.id === currentDb && <span class="d">{t("当前表")}</span>}
            </span>
            {d.id === target ? <span class="chk"><Icon name="check" cls="ico sm" /></span> : <ReturnHint />}
          </button>
        ))}
        {matches.length > CAP && <MenuLabel>{t("还有 {n} 条，继续输入过滤", { n: matches.length - CAP })}</MenuLabel>}
      </div>
    </>
  );
}

function ClearQuery({ query, onClear }: { query: string; onClear: () => void }) {
  if (!query) return null;
  return (
    <button class="clear" {...tip(t("清空"))} onMouseDown={(e) => e.preventDefault()} onClick={onClear}>
      <Icon name="x" cls="ico sm" />
    </button>
  );
}

function openAddCol(e: MouseEvent | MenuAnchor, dbId: string, allProps: Prop[], reload: () => Promise<void>, position?: number) {
  if (e instanceof MouseEvent) e.stopPropagation();
  openMenu(e, (close) => <AddColMenu dbId={dbId} allProps={allProps} reload={reload} close={close} position={position} />);
}
/** Fractional position that slots a new column before/after `prop`. */
function positionNear(allProps: Prop[], prop: Prop, where: DropWhere): number {
  const i = allProps.findIndex((p) => p.id === prop.id);
  const nb = where === "before" ? allProps[i - 1] : allProps[i + 1];
  if (!nb) return where === "before" ? prop.position - 1 : prop.position + 1;
  return (prop.position + nb.position) / 2;
}
function AddColMenu({ dbId, allProps, reload, close, position }: { dbId: string; allProps: Prop[]; reload: () => Promise<void>; close: () => void; position?: number }) {
  // relation can't be created from the type alone — it needs a target database,
  // so picking it swaps the menu to a second step instead of creating.
  const [pickTarget, setPickTarget] = useState(false);
  const create = (pt: PropType, config: PropConfig | undefined, base: string) => {
    close();
    api.createProperty({ db: dbId, name: uniquePropName(base, allProps), type: pt, config })
      .then((p) => (position == null ? p : api.updateProperty(p.id, { position })))
      .then(reload)
      .catch((e) => toast(t("新建属性失败：{msg}", { msg: (e as Error).message })));
  };
  if (pickTarget)
    return (
      <>
        <MenuLabel>{t("选择关联的数据表")}</MenuLabel>
        <DbTargetList currentDb={dbId} autoFocus onPick={(d) => create("relation", { database: d.id }, d.name || TYPE_META.relation.t)} />
        <MenuSep />
        <MenuItem icon="arrowLeft" label={t("返回")} onClick={() => setPickTarget(false)} />
      </>
    );
  return (
    <>
      <MenuLabel>{t("新建属性 · 选择类型")}</MenuLabel>
      <div class="typegrid">
        {(Object.keys(TYPE_META) as PropType[]).map((pt) => (
          <button key={pt} class="item" onClick={() => {
            if (pt === "relation") { setPickTarget(true); return; }
            const cfg = pt === "select" || pt === "multi_select" ? { options: [t("选项 1"), t("选项 2")] } : undefined;
            create(pt, cfg, TYPE_META[pt].t);
          }}>
            <span class="lico"><Icon name={TYPE_ICON[pt]!} cls="ico sm" /></span>
            <span class="d">{TYPE_META[pt].t}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function openCalcMenu(e: MouseEvent, prop: Prop, cur: CalcKind | undefined, onPick: (k: CalcKind | null) => void) {
  openMenu(e, (close) => (
    <>
      <MenuLabel>{t("计算")}</MenuLabel>
      <MenuItem label={t("无")} checked={!cur} onClick={() => { close(); onPick(null); }} />
      {calcKindsFor(prop.type).map((k) => (
        <MenuItem key={k} label={calcLabel(k)} checked={cur === k} onClick={() => { close(); onPick(k); }} />
      ))}
    </>
  ));
}

function openRowMenu(e: MouseEvent, rec: Rec, onOpen: () => void, onDup: () => void, onDel: () => void) {
  e.stopPropagation();
  openMenu(e, (close) => (
    <>
      <MenuItem icon="cornerUpRight" label={t("打开记录")} onClick={() => { close(); onOpen(); }} />
      <MenuItem icon="copy" label={t("复制记录")} onClick={() => { close(); onDup(); }} />
      <MenuSep />
      <MenuItem icon="trash" label={t("删除记录")} danger onClick={() => { close(); onDel(); }} />
    </>
  ));
}

// ---- record peek panel ----
export function RecordPeek({
  db, props, rec, onClose, onCommit, onDelete, onDuplicate, onReverted, onRelCreated, hidden = [], prevId, nextId, onNavigate,
}: {
  db: Db; props: Prop[]; rec: Rec;
  onClose: () => void; onCommit: (p: Prop, v: unknown) => void; onDelete: () => void; onDuplicate: () => void;
  onReverted: () => void; onRelCreated: (p: Prop) => void;
  /** Property ids the current view hides: folded under a toggle row here. */
  hidden?: string[];
  /** Neighbours in the current view's visible order (↑/↓ in the drawer head). */
  prevId?: string | null; nextId?: string | null; onNavigate?: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [hist, setHist] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const hiddenSet = new Set(hidden);
  const shownProps = props.filter((p) => !hiddenSet.has(p.id));
  const hiddenProps = props.filter((p) => hiddenSet.has(p.id));
  const propRow = (p: Prop) => (
    <div key={p.id} class="proprow">
      <div
        class="k"
        onClick={(e) =>
          openMenu(e, (close) => (
            <MenuItem icon="history" label={t("字段修改历史")} onClick={() => { close(); openFieldHistory(rec.id, p.id, p.name); }} />
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
  );
  const { open, close } = useDrawerTransition(onClose);
  const { width, handle } = useDrawerResize("mh.peekW");
  const titleProp = props[0];
  // Free-text titles edit in place; other types edit through their proprow
  // editors below (committing raw <h2> text would corrupt them).
  const titleEditable = titleProp != null && isPlainTextEditable(titleProp.type);
  return (
    <>
      <div class={"scrim" + (open ? " open" : "")} onClick={close} />
      <div class={"peek" + (open ? " open" : "")} style={width != null ? { width: `${width}px` } : undefined}>
        {handle}
        <div class="peek-head">
          <button class="iconbtn" {...tip(t("关闭"))} onClick={close}><Icon name="x" /></button>
          {hist && (
            <button class="iconbtn" {...tip(t("返回字段"))} onClick={() => setHist(false)}>
              <Icon name="arrowLeft" />
            </button>
          )}
          {onNavigate && (
            <div class="peek-nav">
              <button class="iconbtn" {...tip(t("上一条"))} disabled={!prevId} onClick={() => prevId && onNavigate(prevId)}><Icon name="arrowUp" /></button>
              <button class="iconbtn" {...tip(t("下一条"))} disabled={!nextId} onClick={() => nextId && onNavigate(nextId)}><Icon name="arrowDown" /></button>
            </div>
          )}
          <div style={{ flex: 1 }} />
          <button class="iconbtn" {...tip(t("更多"))} onClick={(e) =>
            openMenu(e, (close) => (
              <>
                <MenuItem icon="history" label={t("版本历史")} checked={hist} onClick={() => { close(); setHist(!hist); }} />
                <MenuItem icon="link" label={t("复制链接")} onClick={() => {
                  close();
                  const url = `${location.origin}${location.pathname}#/db/${encodeURIComponent(db.id)}/${encodeURIComponent(rec.id)}`;
                  navigator.clipboard.writeText(url).then(() => toast(t("已复制链接")), () => toast(t("复制失败")));
                }} />
                <MenuItem icon="copy" label={t("复制记录")} onClick={() => { close(); onDuplicate(); }} />
                <MenuSep />
                <MenuItem icon="trash" label={t("删除记录")} danger onClick={() => { close(); onDelete(); }} />
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
                contentEditable={titleEditable}
                {...(titleEditable ? plainPasteHandlers() : {})}
                onBlur={titleEditable ? (e) => onCommit(titleProp, (e.target as HTMLElement).textContent ?? "") : undefined}
              >
                {titleProp ? String(rec.cells[titleProp.id] ?? t("无标题")) : t("无标题")}
              </h2>
              {shownProps.map(propRow)}
              {hiddenProps.length > 0 && (
                <button class="peek-hidden-toggle" onClick={() => setShowHidden(!showHidden)}>
                  <Icon name="chevron" cls={"ico sm" + (showHidden ? " down" : "")} />
                  {showHidden ? t("收起隐藏的属性") : t("还有 {n} 个隐藏的属性", { n: hiddenProps.length })}
                </button>
              )}
              {showHidden && hiddenProps.map(propRow)}
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
          <a class="iconbtn peekdocs-open" {...tip(t("在主视图打开"))} href={`#/doc/${encodeURIComponent(activeId)}`}>
            <Icon name="cornerUpRight" cls="ico sm" />
          </a>
        )}
      </div>
      {activeMissing ? (
        <div class="empty">{t("文档不存在或未同步")}</div>
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
  if (prop.type === "date")
    return <div class="v" onClick={(e) => openDatePicker(e as unknown as MouseEvent, val, onCommit)}><CellDisplay prop={prop} val={val} /></div>;
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
