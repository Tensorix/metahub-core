import { databaseFirstFrame } from './database-first-frame';
import type { DatabaseQueryWindow } from '../shared/views/database-source';
import { deferTouchDrag } from "./touch-intent";
/** @jsxImportSource preact */
// Kanban / board view: groups records into columns by a select (or multi_select)
// property. Cards can be dragged between columns to change their group value
// (single-select only) and reordered within the global record order via onMove.
import { useDatabasePresentation, useViewport } from "./database-presentation";
import { virtualWindow } from "./virtual-window";
import { useLayoutEffect, useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Prop, Rec } from "./api.ts";
import { Icon, TYPE_ICON } from "./icons.tsx";
import { Chip, CellDisplay, optColor, isPlainTextEditable } from "./cells.tsx";
import { openMenu, MenuItem, MenuLabel } from "./ui.tsx";
import { startPointerDrag, positionGhost, clearDropMarks } from "./pointer-drag.ts";
import { plainPasteHandlers } from "./plain-edit.ts";
import { t } from "./i18n/t.ts";
import { tip } from "./shortcuts.ts";

const UNGROUPED = "\u0000__ungrouped__"; // sentinel column key for empty/unknown values

export function BoardView({
  props,
  records,
  queryWindow,
  onCommitValue,
  onCreate,
  onOpenRecord,
  onMove,
  group,
  onGroupChange,
  barExtra,
  highlight,
  hidden = [],
}: {
  hidden?: string[];
  queryWindow?: DatabaseQueryWindow;
  props: Prop[];
  records: Rec[];
  onCommitValue: (rec: Rec, prop: Prop, value: unknown) => void;
  onCreate: (values: Record<string, unknown>) => void;
  onOpenRecord: (id: string) => void;
  onMove: (srcId: string, targetId: string, where: "before" | "after") => void;
  /** Controlled group property id (quick-board persists it); omit for the
   *  original uncontrolled per-mount behavior in the main table view. */
  group?: string | null;
  onGroupChange?: (id: string) => void;
  /** Right-aligned extra content in the board bar (the main view's 浮窗看板
   *  button); the quick-board window omits it. */
  barExtra?: ComponentChildren;
  /** Record ids to pulse with the `flash` card animation (the quick-board
   *  window highlights rows a live-feed poke just changed). */
  highlight?: Set<string>;
}) {
  const [boardRef, size] = useViewport<HTMLDivElement>();
  const presentation = useDatabasePresentation(size.width);
  const cardHeight = presentation.card, cardGap = presentation.cardGap, cardStep = cardHeight + cardGap;
  const columnStep = 292;
  const visibleColumns = presentation.touch ? Math.max(1, Math.ceil(size.width / columnStep)) : Math.max(1, Math.ceil(size.width / columnStep));
  const [horizontal,setHorizontal]=useState(0);
  const [scrolls,setScrolls]=useState<Record<string,number>>({});
  const groupable = props.filter((p) => p.type === "select" || p.type === "multi_select");
  const [ownGroupId, setOwnGroupId] = useState<string | null>(null);
  // Card whose title is being edited inline (click-without-drag). Keyed by
  // record AND column: a multi_select-grouped record renders one card per
  // matching column, and mounting an editor in each would make them fight over
  // focus and blur-close each other instantly.
  const [editing, setEditing] = useState<{ id: string; col: string } | null>(null);
  const groupId = group !== undefined ? group : ownGroupId;
  const setGroupId = (id: string): void => {
    onGroupChange?.(id);
    if (group === undefined) setOwnGroupId(id);
  };
  const groupProp =
    props.find((p) => p.id === groupId) ??
    groupable.find((p) => p.type === "select") ??
    groupable[0] ??
    null;

  useLayoutEffect(()=>{
    if(!queryWindow?.index)return;
    let current=true;
    if(!groupProp){databaseFirstFrame(()=>current);return()=>{current=false;};}
    const jobs:Promise<void>[]=[];
    const keys=[...(groupProp.config?.options ?? []),UNGROUPED].slice(Math.max(0,Math.floor(horizontal/columnStep)-1),Math.floor(horizontal/columnStep)+visibleColumns+1);
    for(const key of keys){const start=Math.max(0,Math.floor((scrolls[key]??0)/cardStep)-5);jobs.push(queryWindow.ensure(start,start+Math.ceil(size.height/cardStep)+8,'group:'+JSON.stringify(key===UNGROUPED?null:key)));}
    void Promise.all(jobs).then(()=>databaseFirstFrame(()=>current));
    return()=>{current=false;};
  },[queryWindow,queryWindow?.index?.id,queryWindow?.index?.progress,groupProp?.id,horizontal,scrolls,cardStep,size.height,visibleColumns]);
  if (!groupProp) {
    return (
      <div class="view-placeholder">
        {t("看板视图需要一个「单选」或「多选」属性来分组。请在表格视图中添加一个单选列后再切换到看板。")}
      </div>
    );
  }

  const titleProp = props[0];
  // Inline title editing commits raw contentEditable text, so it only applies
  // to free-text title types; for the rest a click opens the record instead
  // (the peek has the proper per-type editors).
  const titleEditable = titleProp != null && isPlainTextEditable(titleProp.type);
  const isMulti = groupProp.type === "multi_select";
  const options = groupProp.config?.options ?? [];

  // Build the column key for each record (multi_select records land in every
  // selected option's column; empty/unknown go to the ungrouped column).
  const colsFor = (rec: Rec): string[] => {
    const v = rec.cells[groupProp.id];
    if (isMulti) {
      const arr = (Array.isArray(v) ? v : []).map(String).filter((x) => options.includes(x));
      return arr.length ? arr : [UNGROUPED];
    }
    const s = v == null ? "" : String(v);
    return s && options.includes(s) ? [s] : [UNGROUPED];
  };

  const byCol = new Map<string, Rec[]>();
  for (const o of options) byCol.set(o, []);
  byCol.set(UNGROUPED, []);
  for (const rec of records.filter(Boolean)) for (const k of colsFor(rec)) byCol.get(k)?.push(rec);
  // Keep the ungrouped column only when it holds records.
  const columns: string[] = [...options];
  if ((queryWindow ? queryWindow.index?.partitions['group:null'] ?? 0 : byCol.get(UNGROUPED)?.length ?? 0) > 0) columns.push(UNGROUPED);

  const startDrag = (e: any, rec: Rec, col: string) => {
    if(deferTouchDrag(e,ev=>startDrag(ev,rec,col),()=>onOpenRecord(rec.id)))return;
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button,a,input,[contenteditable]")) return;
    const card = (e.currentTarget as HTMLElement).closest(".kcard") as HTMLElement;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    e.preventDefault();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    let ghost: HTMLElement | null = null;
    startPointerDrag(e, {
      onStart: () => {
        // The card ghost is a live clone (chips, fields), not a text label.
        ghost = card.cloneNode(true) as HTMLElement;
        ghost.classList.add("dragging-ghost");
        ghost.style.width = `${rect.width}px`;
        document.body.appendChild(ghost);
        card.classList.add("drag-source");
        document.body.classList.add("table-dragging");
      },
      onMove: (ev) => {
        positionGhost(ghost, ev.clientX - offX, ev.clientY - offY);
        clearDropMarks();
        const col = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".board-col") as HTMLElement | null;
        col?.classList.add("drop-into");
      },
      onEnd: (ev, active) => {
        ghost?.remove();
        card.classList.remove("drag-source");
        document.body.classList.remove("table-dragging");
        clearDropMarks();
        // Click without drag edits the title in place (free-text titles only;
        // opening the peek is otherwise the hover button's job, and the sole
        // click action for non-text title types).
        if(ev.type==="pointercancel")return;
        if (!active) {
          if (titleEditable) setEditing({ id: rec.id, col });
          else onOpenRecord(rec.id);
          return;
        }
        const colEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".board-col") as HTMLElement | null;
        if (!colEl) return;
        // Single-select: dropping into a column changes the group value. Multi-select
        // can't be unambiguously reassigned by a drag, so we only allow reordering.
        if (!isMulti) {
          const destKey = colEl.dataset.colKey!;
          const cur = String(rec.cells[groupProp.id] ?? "");
          const destValue = destKey === UNGROUPED ? null : destKey;
          if (String(destValue ?? "") !== cur) onCommitValue(rec, groupProp, destValue);
        }
        // Reorder relative to the card dropped onto (same global order list).
        const cardEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".kcard") as HTMLElement | null;
        const targetId = cardEl?.dataset.recId;
        if (targetId && targetId !== rec.id) {
          const r = cardEl!.getBoundingClientRect();
          onMove(rec.id, targetId, ev.clientY < r.top + r.height / 2 ? "before" : "after");
        }
      },
    });
  };

  const pickGroup = (e: MouseEvent) =>
    openMenu(e, (close) => (
      <>
        <MenuLabel>{t("按属性分组")}</MenuLabel>
        {groupable.map((p) => (
          <MenuItem
            key={p.id}
            icon={TYPE_ICON[p.type]}
            label={p.name}
            onClick={() => { setGroupId(p.id); close(); }}
          />
        ))}
      </>
    ));

  return (
    <div class="board-wrap">
      <div class="board-bar">
        <button class="tbtn" onClick={pickGroup}>
          <Icon name="group" cls="ico sm" />{t("分组：{name}", { name: groupProp.name })}
        </button>
        {isMulti && <span class="muted" style={{ fontSize: 12 }}>{t("多选分组不支持拖拽改值")}</span>}
        <div class="spacer" style={{ flex: 1 }} />
        {barExtra}
      </div>
      <div class="board" ref={boardRef} onScroll={event=>setHorizontal(event.currentTarget.scrollLeft)}>
        {Math.floor(horizontal/columnStep)>1 && <div style={{flex:"none",width:(Math.floor(horizontal/columnStep)-1)*292-12}}/>}
        {columns.slice(Math.max(0,Math.floor(horizontal/columnStep)-1),Math.floor(horizontal/columnStep)+visibleColumns+1).map((key) => {
          const recs = queryWindow ? queryWindow.rows('group:'+JSON.stringify(key===UNGROUPED?null:key)) : byCol.get(key) ?? [];
          const window=virtualWindow(recs.length,cardStep,scrolls[key] ?? 0,Math.max(0,size.height-48));
          const editIndex=editing?.col===key ? recs.findIndex(r=>r?.id===editing.id) : -1;
          if(editIndex>=0){window.start=Math.min(window.start,editIndex);window.end=Math.max(window.end,editIndex+1);}
          const ungrouped = key === UNGROUPED;
          return (
            // --col-tint: the column's option color. The main app doesn't
            // consume it; the quick-board window tints columns and card edges.
            <div
              class="board-col"
              data-col-key={key}
              key={key}
              style={`--col-tint:${ungrouped ? "var(--muted)" : optColor(key)}`}
            >
              <div class="board-col-head">
                {ungrouped ? <span class="muted" style={{ fontWeight: 600 }}>{t("未分组")}</span> : <Chip text={key} />}
                <span class="board-count">{queryWindow?.index?.statistics==="loading"?"…":recs.length}</span>
                <div class="spacer" />
                <button class="iconbtn sm" {...tip(t("新建记录"))} onClick={() => onCreate(ungrouped ? {} : { [groupProp.id]: key })}>
                  <Icon name="plus" cls="ico sm" />
                </button>
              </div>
              <div class="board-col-body" style={{maxHeight:presentation.touch ? undefined : "65vh",gap:cardGap}} onScroll={event=>setScrolls(old=>({...old,[key]:event.currentTarget.scrollTop}))}>
                {window.start>0 && <div style={{height:window.start*cardStep-cardGap,flex:"none"}}/>}
                {Array.from({length:window.end-window.start},(_,i)=>{const rec=recs[window.start+i];return !rec ? <div class="kcard" aria-busy="true" style={{height:cardHeight,flex:"none"}}>…</div> : (
                  <div
                    style={{height:cardHeight,boxSizing:"border-box",overflow:"hidden",flex:"none"}} class={"kcard" + (highlight?.has(rec.id) ? " flash" : "")}
                    role="button" tabIndex={0} aria-label={titleText(rec,titleProp) || t("无标题")} onKeyDown={e=>{if(e.key==="Enter" || e.key===" "){e.preventDefault();onOpenRecord(rec.id);}}}
                    data-rec-id={rec.id}
                    key={rec.id}
                    onPointerDown={(e) => startDrag(e, rec, key)}
                  >
                    {editing?.id === rec.id && editing.col === key && titleProp ? (
                      <CardTitleEdit
                        initial={titleText(rec, titleProp)}
                        onDone={(v) => {
                          setEditing(null);
                          if (v != null && v !== titleText(rec, titleProp)) onCommitValue(rec, titleProp, v);
                        }}
                      />
                    ) : (
                      <div class="kcard-title">{titleText(rec, titleProp) || <span class="muted">{t("无标题")}</span>}</div>
                    )}
                    <div class="kcard-actions">
                      <button class="rowopen" {...tip(t("打开"))} onClick={(e) => { e.stopPropagation(); onOpenRecord(rec.id); }}>
                        <Icon name="openPeek" cls="ico sm" />
                      </button>
                    </div>
                    {props
                      .filter((p) => p !== titleProp && p.id !== groupProp.id && !hidden.includes(p.id) && !isEmpty(rec.cells[p.id]))
                      .slice(0, presentation.touch ? 2 : 4)
                      .map((p) => (
                        <div class="kcard-field" key={p.id}>
                          <Icon name={TYPE_ICON[p.type] ?? "text"} cls="ico sm" />
                          <CellDisplay prop={p} val={rec.cells[p.id]} />
                        </div>
                      ))}
                  </div>
                );})}
                {window.end<recs.length && <div style={{height:(recs.length-window.end)*cardStep-cardGap,flex:"none"}}/>}
                <button class="board-add" onClick={() => onCreate(ungrouped ? {} : { [groupProp.id]: key })}>
                  <Icon name="plus" cls="ico sm" />{t("新建")}
                </button>
              </div>
            </div>
          );
        })}
        {columns.length>Math.floor(horizontal/columnStep)+visibleColumns+1 && <div style={{flex:"none",width:(columns.length-Math.floor(horizontal/columnStep)-visibleColumns-1)*292-12}}/>}
      </div>
    </div>
  );
}

/** Inline card-title editor: the SAME .kcard-title element made contentEditable
 *  (like the peek panel's <h2>), so a wrapped multi-line title keeps its exact
 *  layout while editing — an <input> would collapse it to a single line.
 *  Enter/blur commit, Escape cancels; onDone gets null on cancel. */
function CardTitleEdit({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current!;
    el.textContent = initial;
    el.focus();
    // caret at the end, matching the grid editor's behavior
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);
  // Enter/Escape unmount the div, which fires a trailing blur — the `done`
  // flag keeps that blur from reporting a second end (same as InlineEditInput).
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(commit ? (ref.current?.textContent ?? "") : null);
  };
  return (
    <div
      ref={ref}
      class="kcard-title"
      contentEditable
      {...plainPasteHandlers()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.isComposing || e.keyCode === 229) return; // IME: Enter confirms the candidate
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      }}
    />
  );
}

function titleText(rec: Rec, titleProp: Prop | undefined): string {
  if (!titleProp) return "";
  const v = rec.cells[titleProp.id];
  return v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
}

function isEmpty(v: unknown): boolean {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}
