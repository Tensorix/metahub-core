import { databaseFirstFrame } from './database-first-frame';
import type { DatabaseQueryWindow } from '../shared/views/database-source';
import { startPointerDrag } from "./pointer-drag";
import { deferTouchDrag } from "./touch-intent";
/** @jsxImportSource preact */
// Timeline (gantt) view: lays records on a horizontal day axis using a start
// date and an optional end date. Bars span start→end; records with only a start
// render as a single-point milestone. Drag the bar body to shift the whole
// range, or the left/right edge handle to change just the start/end.
import { useDatabasePresentation, useViewport } from "./database-presentation";
import { virtualWindow } from "./virtual-window";
import { useLayoutEffect, useRef, useState, useEffect } from "preact/hooks";
import type { Prop, Rec } from "./api.ts";
import { Icon, TYPE_ICON } from "./icons.tsx";
import { openMenu, MenuItem, MenuLabel, MenuSep } from "./ui.tsx";
import { parseDate, toISO, addDays, daysBetween, today } from "./date.ts";
import { fmtDate } from "./i18n/fmt.ts";
import { t } from "./i18n/t.ts";

const DESKTOP_SIDE = 200; // px width of the sticky record-name column
const DESKTOP_ROW = 36; // px row height
const HEAD = 44; // px axis height
const DAY_PX = 28; // px per day
const PAD = 3; // days of padding on each side of the data range

export function TimelineView({
  props,
  records,
  queryWindow,
  onCommitValue,
  onOpenRecord,
  startField,
  endField,
  onFieldsChange,
}: {
  queryWindow?: DatabaseQueryWindow;
  props: Prop[];
  records: Rec[];
  onCommitValue: (rec: Rec, prop: Prop, value: unknown) => void;
  onCreate: (values: Record<string, unknown>) => void;
  onOpenRecord: (id: string) => void;
  /** Controlled start/end property ids (saved on the view); omit for per-mount state. */
  startField?: string | null;
  endField?: string | null | "none";
  onFieldsChange?: (f: { start?: string; end?: string | "none" }) => void;
}) {
  const [scrollRef,size] = useViewport<HTMLDivElement>();
  const presentation = useDatabasePresentation(size.width);
  const SIDE = presentation.timelineSide, ROW = presentation.timelineRow;
  const [showUndated,setShowUndated] = useState(false);
  const [selected,setSelected]=useState<string|null>(null);
  const [viewport,setViewport]=useState({top:0,left:0,width:1024,height:700});
  const dateProps = props.filter((p) => p.type === "date");
  const [ownStartId, setOwnStartId] = useState<string | null>(null);
  const [ownEndId, setOwnEndId] = useState<string | null | "none">(null);
  const controlled = startField !== undefined;
  const startId = controlled ? startField : ownStartId;
  const endId = controlled ? (endField ?? null) : ownEndId;
  const setStartId = (id: string) => { onFieldsChange?.({ start: id }); if (!controlled) setOwnStartId(id); };
  const setEndId = (id: string | "none") => { onFieldsChange?.({ end: id }); if (!controlled) setOwnEndId(id); };
  const startProp = props.find((p) => p.id === startId) ?? dateProps[0] ?? null;
  const endProp =
    endId === "none" ? null : (props.find((p) => p.id === endId) ?? dateProps.find((p) => p !== startProp) ?? null);
  const dragRef = useRef<{ pointerId: number; startX: number } | null>(null);
  const guideRef = useRef<HTMLDivElement>(null);

  const partition = presentation.touch ? 'date:scheduled' : undefined;
  const sourceRows = queryWindow && partition ? queryWindow.rows(partition) : records;
  useLayoutEffect(()=>{if(!queryWindow?.index)return;let current=true;const start=Math.max(0,Math.floor(viewport.top/ROW)-4);void queryWindow.ensure(start,start+Math.ceil(size.height/ROW)+8,partition).then(()=>databaseFirstFrame(()=>current));return()=>{current=false;};},[queryWindow,queryWindow?.index?.id,queryWindow?.index?.progress,viewport.top,ROW,size.height,partition]);
  const [undatedPage,setUndatedPage]=useState(0);
  useEffect(()=>{if(showUndated)void queryWindow?.ensure(undatedPage*100,(undatedPage+1)*100,'date:');},[showUndated,undatedPage,queryWindow,queryWindow?.index?.id]);
  if (!startProp) {
    return <div class="view-placeholder">{t("时间轴视图需要一个「日期」属性作为开始日期。请在表格视图中添加一个日期列后再切换到时间轴。")}</div>;
  }

  const titleProp = props[0];
  const now = today();

  // Resolve each record's start/end days.
  const rows = (presentation.touch && !queryWindow ? sourceRows.filter(rec=>rec && parseDate(rec.cells[startProp.id])) : sourceRows).map((rec) => {
    const s = parseDate(rec.cells[startProp.id]);
    const e = endProp ? parseDate(rec.cells[endProp.id]) : null;
    return { rec, s, e: e && s && e < s ? s : e };
  });

  // Overall date range (fall back to a window around today when there's no data).
  const dated = rows.filter((r) => r.s);
  let min = now;
  let max = now;
  if (dated.length) {
    min = dated[0]!.s!;
    max = dated[0]!.s!;
    for (const r of dated) {
      if (r.s! < min) min = r.s!;
      const end = r.e ?? r.s!;
      if (end > max) max = end;
    }
  } else {
    min = addDays(now, -10);
    max = addDays(now, 14);
  }
  if(queryWindow?.index?.range.min)min=parseDate(queryWindow.index.range.min)!;
  if(queryWindow?.index?.range.max)max=parseDate(queryWindow.index.range.max)!;
  const rangeStart = addDays(min, -PAD);
  const rangeEnd = addDays(max, PAD);
  const totalDays = daysBetween(rangeStart, rangeEnd) + 1;
  const canvasW = SIDE + totalDays * DAY_PX;
  const xForOffset = (o: number) => SIDE + o * DAY_PX;
  const todayOffset = daysBetween(rangeStart, now);

  const datesWindow=virtualWindow(totalDays,DAY_PX,Math.max(0,viewport.left-SIDE),size.width);
  const rowsWindow=virtualWindow(rows.length,ROW,viewport.top,size.height);
  const days=Array.from({length:datesWindow.end-datesWindow.start},(_,i)=>addDays(rangeStart,i+datesWindow.start));

  const commitDelta = (rec: Rec, s: Date | null, e: Date | null, mode: "move" | "l" | "r", deltaDays: number) => {
    if (deltaDays === 0) return;
    if (mode === "move") {
      if (s) onCommitValue(rec, startProp, toISO(addDays(s, deltaDays)));
      if (endProp && e) onCommitValue(rec, endProp, toISO(addDays(e, deltaDays)));
    } else if (mode === "l" && s) {
      const ns = addDays(s, deltaDays);
      onCommitValue(rec, startProp, toISO(e && ns > e ? e : ns));
    } else if (mode === "r" && endProp && e) {
      const ne = addDays(e, deltaDays);
      onCommitValue(rec, endProp, toISO(s && ne < s ? s : ne));
    }
  };

  const showGuide = (x: number, label: string) => {
    const g = guideRef.current;
    if (!g) return;
    g.style.left = x + "px";
    g.style.display = "block";
    const lbl = g.firstElementChild as HTMLElement | null;
    if (lbl) lbl.textContent = label;
  };
  const hideGuide = () => {
    if (guideRef.current) guideRef.current.style.display = "none";
  };

  const startDrag = (ev: any, rec: Rec, s: Date | null, e: Date | null, mode: "move" | "l" | "r", el: HTMLElement) => {
    if(deferTouchDrag(ev,next=>startDrag(next,rec,s,e,mode,el),()=>setSelected(rec.id)))return;
    if (ev.button !== 0 || !s) return;
    ev.preventDefault();
    ev.stopPropagation();
    const startScroll=scrollRef.current?.scrollLeft ?? 0;
    const delta=(event:PointerEvent)=>event.clientX-ev.clientX+(scrollRef.current?.scrollLeft ?? 0)-startScroll;
    const baseLeft = el.offsetLeft;
    const baseWidth = el.offsetWidth;
    let moved = false;
    // Pin the edge grip visible for the whole drag: the pointer routinely
    // leaves the 9px handle mid-drag, which would drop its :hover styling.
    const grip = mode === "move" ? null : (ev.currentTarget as HTMLElement);
    grip?.classList.add("dragging");
    dragRef.current = { pointerId: ev.pointerId, startX: ev.clientX };
    const move = (e2: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e2.pointerId) return;
      const dxDays = Math.round(delta(e2) / DAY_PX);
      if (Math.abs(delta(e2)) > 3) moved = true;
      let edgeX: number; // canvas-x of the edge being aligned, and its date
      let edgeDate: Date;
      if (mode === "move") {
        const left = baseLeft + dxDays * DAY_PX;
        el.style.left = left + "px";
        edgeX = left; edgeDate = addDays(s, dxDays);
      } else if (mode === "l") {
        const left = baseLeft + dxDays * DAY_PX;
        el.style.left = left + "px";
        el.style.width = Math.max(DAY_PX, baseWidth - dxDays * DAY_PX) + "px";
        edgeX = left; edgeDate = addDays(s, dxDays);
      } else {
        const w = Math.max(DAY_PX, baseWidth + dxDays * DAY_PX);
        el.style.width = w + "px";
        edgeX = baseLeft + w; edgeDate = addDays(s, Math.round(w / DAY_PX) - 1);
      }
      showGuide(edgeX, toISO(edgeDate));
    };
    const up = (e2: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e2.pointerId) return;

      dragRef.current = null;
      grip?.classList.remove("dragging");
      hideGuide();
      if(e2.type==="pointercancel"){el.style.left=baseLeft+"px";el.style.width=baseWidth+"px";return;}
      const dxDays = Math.round(delta(e2) / DAY_PX);
      if (!moved) { onOpenRecord(rec.id); return; }
      commitDelta(rec, s, e, mode, dxDays);
    };
    startPointerDrag(ev,{onMove:move,onEnd:up});
  };

  // Give an unscheduled record a start date (and matching end, if an end field
  // is selected, for a 1-day bar) so it appears on the axis and can be dragged.
  const scheduleStart = (rec: Rec, day: Date) => {
    onCommitValue(rec, startProp, toISO(day));
    if (endProp) onCommitValue(rec, endProp, toISO(day));
  };
  // Click on an empty row track → place the record's start at the clicked day.
  const placeAt = (ev: MouseEvent, rec: Rec) => {
    const row = (ev.currentTarget as HTMLElement).closest(".tl-row") as HTMLElement | null;
    if (!row) return;
    const x = ev.clientX - row.getBoundingClientRect().left;
    if (x < SIDE) return;
    const i = Math.max(0, Math.min(totalDays - 1, Math.round((x - SIDE) / DAY_PX)));
    scheduleStart(rec, addDays(rangeStart, i));
  };

  const pickField = (e: MouseEvent) =>
    openMenu(e, (close) => (
      <>
        <MenuLabel>{t("开始日期")}</MenuLabel>
        {dateProps.map((p) => (
          <MenuItem key={p.id} icon={TYPE_ICON[p.type]} label={p.name} checked={p === startProp} onClick={() => { setStartId(p.id); close(); }} />
        ))}
        <MenuSep />
        <MenuLabel>{t("结束日期（可选）")}</MenuLabel>
        <MenuItem icon="x" label={t("无（里程碑）")} checked={!endProp} onClick={() => { setEndId("none"); close(); }} />
        {dateProps.map((p) => (
          <MenuItem key={p.id} icon={TYPE_ICON[p.type]} label={p.name} checked={p === endProp} onClick={() => { setEndId(p.id); close(); }} />
        ))}
      </>
    ));

  return (
    <div class="tl" style={{"--timeline-row":`${ROW}px`}}>
      <div class="tl-toolbar">
        <button class="tbtn" onClick={pickField}>
          <Icon name="timeline" cls="ico sm" />
          {startProp.name}{endProp ? ` → ${endProp.name}` : t("（里程碑）")}
        </button>
        <button class="tbtn" onClick={()=>{if(scrollRef.current)scrollRef.current.scrollLeft=Math.max(0,todayOffset*DAY_PX-(size.width-SIDE)/2);}}>今天</button>
        {presentation.touch && <button class="tbtn" aria-expanded={showUndated} onClick={()=>setShowUndated(v=>!v)}>未排期 {queryWindow?.index?.statistics==="loading"?"…":queryWindow?.index?.partitions['date:'] ?? records.filter(r=>r && !parseDate(r.cells[startProp.id])).length}</button>}
      </div>
      {showUndated && <div class="tl-undated">
        {(queryWindow ? queryWindow.rows('date:') : records.filter(r=>r && !parseDate(r.cells[startProp.id]))).slice(undatedPage*100,(undatedPage+1)*100).map(rec=><div class="tl-undated-record" key={rec.id}><button onClick={()=>onOpenRecord(rec.id)}>{titleText(rec,titleProp) || '无标题'}</button><button onClick={()=>scheduleStart(rec,now)}>排到今天</button></div>)}
        <div><button disabled={!undatedPage} onClick={()=>setUndatedPage(p=>p-1)}>上一页</button><button disabled={(undatedPage+1)*100>=(queryWindow?.index?.partitions['date:'] ?? records.length)} onClick={()=>setUndatedPage(p=>p+1)}>下一页</button></div>
      </div>}
      {presentation.touch && selected && (()=>{const rec=queryWindow?.find(selected) ?? records.find(r=>r?.id===selected);if(!rec)return null;return <div class="tl-selection" role="region" aria-label="任务操作"><strong>{titleText(rec,titleProp) || '无标题'}</strong><button onClick={()=>onOpenRecord(rec.id)}>查看详情</button><button onClick={()=>setSelected(null)}>取消选择</button><label>开始日期<input type="date" value={String(rec.cells[startProp.id] ?? '')} onChange={ev=>{if(ev.currentTarget.value)onCommitValue(rec,startProp,ev.currentTarget.value);}}/></label>{endProp && <label>结束日期<input type="date" value={String(rec.cells[endProp.id] ?? '')} onChange={ev=>onCommitValue(rec,endProp,ev.currentTarget.value || null)}/></label>}<button onClick={()=>commitDelta(rec,parseDate(rec.cells[startProp.id]),endProp?parseDate(rec.cells[endProp.id]):null,'move',-1)}>提前一天</button><button onClick={()=>commitDelta(rec,parseDate(rec.cells[startProp.id]),endProp?parseDate(rec.cells[endProp.id]):null,'move',1)}>推迟一天</button></div>;})()}
      <div class="tl-scroll" ref={scrollRef} style={{maxHeight:presentation.touch ? undefined : "70vh"}} onScroll={event=>{const el=event.currentTarget;setViewport({top:el.scrollTop,left:el.scrollLeft,width:el.clientWidth,height:el.clientHeight});}}>
        <div class="tl-canvas" style={{ width: canvasW, height: HEAD + rows.length * ROW + 8 }}>
          <div class="tl-axis" style={{ height: HEAD }}>
            <div class="tl-corner" style={{ width: SIDE }}>{t("记录")}</div>
            {days.map((d, index) => { const i=index+datesWindow.start;
              const first = d.getDate() === 1;
              return (
                <div
                  class={"tl-tick" + (first ? " mstart" : "") + (daysBetween(d, now) === 0 ? " today" : "")}
                  key={i}
                  style={{ left: xForOffset(i), width: DAY_PX }}
                >
                  {first && <span class="tl-month">{fmtDate(d, "month")}</span>}
                  <span class="tl-dnum">{d.getDate()}</span>
                </div>
              );
            })}
          </div>

          {rows.slice(rowsWindow.start,rowsWindow.end).map(({ rec, s, e }, index) => { const ri=index+rowsWindow.start;
            const offset = s ? daysBetween(rangeStart, s) : 0;
            const span = s && e ? daysBetween(s, e) + 1 : 1;
            return (
              <div class="tl-row" key={rec.id} style={{ top: HEAD + ri * ROW, height: ROW }}>
                <button class="tl-rowlabel" onClick={()=>onOpenRecord(rec.id)} style={{ width: SIDE }}>{titleText(rec, titleProp) || <span class="muted">{t("无标题")}</span>}</button>
                {!s ? (
                  <div class="tl-track-empty" style={{ left: SIDE }} onClick={(ev) => placeAt(ev, rec)} title={t("点击空白处排期")}>
                    <button class="tl-schedule" style={{ left: SIDE + 8 }} onClick={(ev) => { ev.stopPropagation(); scheduleStart(rec, now); }}>
                      {t("未排期 · 排到今天")}
                    </button>
                  </div>
                ) : e ? (
                  <div
                    role="button" tabIndex={0} aria-pressed={selected===rec.id} aria-label={titleText(rec,titleProp)} onKeyDown={ev=>{if(ev.key==="Enter" || ev.key===" "){ev.preventDefault();setSelected(rec.id);}}}
                    class={"tl-item"+(selected===rec.id?" selected":"")}
                    style={{ left: xForOffset(offset), width: span * DAY_PX }}
                    onPointerDown={(ev) => startDrag(ev, rec, s, e, "move", ev.currentTarget as HTMLElement)}
                  >
                    <span class="tl-h l" onPointerDown={(ev) => startDrag(ev, rec, s, e, "l", (ev.currentTarget as HTMLElement).parentElement as HTMLElement)} />
                    <span class="tl-label">{titleText(rec, titleProp)}</span>
                    <span class="tl-h r" onPointerDown={(ev) => startDrag(ev, rec, s, e, "r", (ev.currentTarget as HTMLElement).parentElement as HTMLElement)} />
                  </div>
                ) : (
                  <div
                    role="button" tabIndex={0} aria-label={titleText(rec,titleProp)} aria-pressed={selected===rec.id} onKeyDown={ev=>{if(ev.key==="Enter" || ev.key===" "){ev.preventDefault();setSelected(rec.id);}}}
                    class={"tl-milestone"+(selected===rec.id?" selected":"")}
                    style={{ left: xForOffset(offset) }}
                    title={toISO(s)}
                    onPointerDown={(ev) => startDrag(ev, rec, s, null, "move", ev.currentTarget as HTMLElement)}
                  />
                )}
              </div>
            );
          })}

          {todayOffset >= 0 && todayOffset < totalDays && (
            <div class="tl-today" style={{ left: xForOffset(todayOffset) + DAY_PX / 2, height: HEAD + rows.length * ROW }} />
          )}
          {/* drag alignment guide (shown imperatively during bar drag) */}
          <div class="tl-guide" ref={guideRef} style={{ display: "none", height: HEAD + rows.length * ROW }}>
            <span class="tl-guide-label" />
          </div>
        </div>
      </div>
    </div>
  );
}

function titleText(rec: Rec, titleProp: Prop | undefined): string {
  if (!titleProp) return "";
  const v = rec.cells[titleProp.id];
  return v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
}
