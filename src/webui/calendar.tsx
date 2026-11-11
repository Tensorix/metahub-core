import type { DatabaseQueryWindow } from '../shared/views/database-source';
import { startPointerDrag } from "./pointer-drag";
import { deferTouchDrag } from "./touch-intent";
/** @jsxImportSource preact */
// Calendar (month) view: positions records on a month grid by a date property.
// Events can be dragged to another day to reschedule, and days have an inline
// add button that creates a record pre-dated to that day.
import { useRef, useState, useEffect, useLayoutEffect } from "preact/hooks";
import type { Prop, Rec } from "./api.ts";
import { Icon, TYPE_ICON } from "./icons.tsx";
import { optColor } from "./cells.tsx";
import { openMenu, MenuItem, MenuLabel } from "./ui.tsx";
import { monthMatrix, parseDate, toISO, sameDay, today } from "./date.ts";
import { fmtDate, weekdayLabels } from "./i18n/fmt.ts";
import { t } from "./i18n/t.ts";

const WEEKDAYS = weekdayLabels();
const MAX_PER_DAY = 3;

export function CalendarView({
  props,
  records,
  queryWindow,
  onCommitValue,
  onCreate,
  onOpenRecord,
  dateField,
  onDateFieldChange,
}: {
  queryWindow?: DatabaseQueryWindow;
  props: Prop[];
  records: Rec[];
  onCommitValue: (rec: Rec, prop: Prop, value: unknown) => void;
  onCreate: (values: Record<string, unknown>) => void;
  onOpenRecord: (id: string) => void;
  /** Controlled date property id (saved on the view); omit for per-mount state. */
  dateField?: string | null;
  onDateFieldChange?: (id: string) => void;
}) {
  const dateProps = props.filter((p) => p.type === "date");
  const [ownDateId, setOwnDateId] = useState<string | null>(null);
  const dateId = dateField !== undefined ? dateField : ownDateId;
  const setDateId = (id: string) => { onDateFieldChange?.(id); if (dateField === undefined) setOwnDateId(id); };
  const dateProp = props.find((p) => p.id === dateId) ?? dateProps[0] ?? null;
  const now = today();
  const [cursor, setCursor] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() });
  const dragRef = useRef<{ id: string; pointerId: number; startX: number; startY: number; active: boolean; ghost: HTMLElement | null } | null>(null);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail,setDetail]=useState<string|null>(null),[detailPage,setDetailPage]=useState(0);
  useEffect(()=>{
    if(!dateProp || !queryWindow)return;
    for(const day of monthMatrix(cursor.y,cursor.m).flat()) void queryWindow.ensure(0,3,'date:'+toISO(day),3);
  },[queryWindow,queryWindow?.index?.id,cursor.y,cursor.m,dateProp?.id]);
  useEffect(()=>{if(detail!==null)void queryWindow?.ensure(detailPage*100,(detailPage+1)*100,'date:'+detail);},[detail,detailPage,queryWindow,queryWindow?.index?.id]);
  useLayoutEffect(()=>{
    const dialog=dialogRef.current;
    if(detail===null || !dialog)return;
    const restore=document.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('button')?.focus();
    return ()=>{dialog.close();if(restore?.isConnected)restore.focus();};
  },[detail]);
  if (!dateProp) {
    return <div class="view-placeholder">{t("日历视图需要一个「日期」属性。请在表格视图中添加一个日期列后再切换到日历。")}</div>;
  }

  const titleProp = props[0];
  const weeks = monthMatrix(cursor.y, cursor.m);

  // Map each record with a valid date to its day.
  const events = records
    .map((rec) => ({ rec, date: parseDate(rec.cells[dateProp.id]) }))
    .filter((e): e is { rec: Rec; date: Date } => e.date != null);
  const eventsOn = (day: Date) => queryWindow ? queryWindow.rows('date:'+toISO(day)).map(rec=>({rec,date:day})) : events.filter((e) => sameDay(e.date, day));

  const step = (delta: number) => {
    const m = cursor.m + delta;
    setCursor({ y: cursor.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 });
  };
  const goToday = () => setCursor({ y: now.getFullYear(), m: now.getMonth() });

  const clearDrop = () =>
    document.querySelectorAll(".cal-day.drop-into").forEach((n) => n.classList.remove("drop-into"));

  const startDrag = (e: any, rec: Rec) => {
    if(deferTouchDrag(e,ev=>startDrag(ev,rec),()=>onOpenRecord(rec.id)))return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { id: rec.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, ghost: null };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== ev.pointerId) return;
      if (!d.active) {
        if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 4) return;
        d.active = true;
        d.ghost = makeGhost(titleText(rec, titleProp));
        document.body.classList.add("table-dragging");
      }
      ev.preventDefault();
      if (d.ghost) d.ghost.style.transform = `translate3d(${Math.round(ev.clientX + 8)}px, ${Math.round(ev.clientY + 8)}px, 0)`;
      clearDrop();
      (document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".cal-day") as HTMLElement | null)?.classList.add("drop-into");
    };
    const up = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== ev.pointerId) return;

      d.ghost?.remove();
      document.body.classList.remove("table-dragging");
      clearDrop();
      dragRef.current = null;
      if(ev.type==="pointercancel")return;
      if (!d.active) { onOpenRecord(rec.id); return; } // click without drag → open
      const cell = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".cal-day") as HTMLElement | null;
      const iso = cell?.dataset.iso;
      if (iso && iso !== String(rec.cells[dateProp.id] ?? "")) onCommitValue(rec, dateProp, iso);
    };
    startPointerDrag(e,{onMove:move,onEnd:up});
  };

  const pickField = (e: MouseEvent) =>
    openMenu(e, (close) => (
      <>
        <MenuLabel>{t("按日期属性")}</MenuLabel>
        {dateProps.map((p) => (
          <MenuItem key={p.id} icon={TYPE_ICON[p.type]} label={p.name} onClick={() => { setDateId(p.id); close(); }} />
        ))}
      </>
    ));

  return (
    <div class="cal">
      {detail!==null && <dialog ref={dialogRef} class="cal-detail" aria-label="日期记录" onCancel={()=>setDetail(null)}>
        <button onClick={()=>setDetail(null)}>关闭</button><strong>{detail || '未排期'}</strong>
        <button onClick={()=>onCreate(detail?{[dateProp.id]:detail}:{})}>新增记录</button>
        {(queryWindow?.rows('date:'+detail) ?? records.filter(rec=>rec && (parseDate(rec.cells[dateProp.id]) ? toISO(parseDate(rec.cells[dateProp.id])!) : '')===detail)).slice(detailPage*100,(detailPage+1)*100).map(rec=><button onClick={()=>onOpenRecord(rec.id)}>{titleText(rec,titleProp) || '无标题'}</button>)}
        <button disabled={!detailPage} onClick={()=>setDetailPage(p=>p-1)}>上一页</button>
        <button disabled={(detailPage+1)*100>=(queryWindow?.index?.partitions['date:'+detail]??records.filter(rec=>rec && (parseDate(rec.cells[dateProp.id]) ? toISO(parseDate(rec.cells[dateProp.id])!) : '')===detail).length)} onClick={()=>setDetailPage(p=>p+1)}>下一页</button>
      </dialog>}
      <div class="cal-nav">
        <button class="tbtn" onClick={()=>{setDetail('');setDetailPage(0);}}>未排期 {queryWindow?.index?.partitions['date:'] ?? 0}</button>
        <button class="iconbtn" title={t("上个月")} onClick={() => step(-1)}><Icon name="chevron" cls="ico flip" /></button>
        <div class="cal-title">{fmtDate(new Date(cursor.y, cursor.m, 1), "yearMonth")}</div>
        <button class="iconbtn" title={t("下个月")} onClick={() => step(1)}><Icon name="chevron" cls="ico" /></button>
        <button class="tbtn" onClick={goToday}>{t("今天")}</button>
        <div class="spacer" />
        {dateProps.length > 1 && (
          <button class="tbtn" onClick={pickField}><Icon name="calendar" cls="ico sm" />{dateProp.name}</button>
        )}
      </div>
      <div class="cal-grid cal-head">
        {WEEKDAYS.map((w) => <div class="cal-wd" key={w}>{w}</div>)}
      </div>
      <div class="cal-body">
        {weeks.map((week, wi) => (
          <div class="cal-grid cal-week" key={wi}>
            {week.map((day) => {
              const dim = day.getMonth() !== cursor.m;
              const isToday = sameDay(day, now);
              const evs = eventsOn(day);
              const iso = toISO(day);
              return (
                <div
                  class={"cal-day" + (dim ? " dim" : "") + (isToday ? " today" : "")}
                  role="group" aria-label={iso}
                  data-iso={iso}
                  key={iso}
                  onClick={(e) => {
                    // Click empty space in the day to add a record dated to it.
                    if ((e.target as HTMLElement).closest(".cal-ev,.cal-add,.cal-more")) return;
                    setDetail(iso);setDetailPage(0);
                  }}
                >
                  <div class="cal-daynum">
                    <button class="cal-date" aria-label={`${iso}，${evs.length} 条记录`} onClick={e=>{e.stopPropagation();setDetail(iso);setDetailPage(0);}}>{day.getDate()}</button>
                    <button class="cal-add" title={t("新建记录")} onClick={(e) => { e.stopPropagation(); onCreate({ [dateProp.id]: iso }); }}>
                      <Icon name="plus" cls="ico sm" />
                    </button>
                  </div>
                  <div class="cal-events">
                    {evs.slice(0, MAX_PER_DAY).map(({ rec }) => (
                      <div
                        role="button" tabIndex={0} onKeyDown={e=>{if(e.key==="Enter" || e.key===" "){e.preventDefault();onOpenRecord(rec.id);}}}
                        class="cal-ev"
                        key={rec.id}
                        style={{ ["--c" as any]: optColor(titleText(rec, titleProp) || rec.id) }}
                        onPointerDown={(e) => startDrag(e, rec)}
                      >
                        {titleText(rec, titleProp) || t("无标题")}
                      </div>
                    ))}
                    {evs.length > MAX_PER_DAY && (
                      <button
                        class="cal-more"
                        onClick={(e) => {
                          e.stopPropagation();
                          if(queryWindow){setDetail(iso);setDetailPage(0);return;}
                          openMenu(e, (close) => (
                            <>
                              <MenuLabel>{t("{date} · {n} 条记录", { date: iso, n: evs.length })}</MenuLabel>
                              {evs.map(({ rec }) => (
                                <MenuItem
                                  key={rec.id}
                                  label={titleText(rec, titleProp) || t("无标题")}
                                  onClick={() => { close(); onOpenRecord(rec.id); }}
                                />
                              ))}
                            </>
                          ));
                        }}
                      >
                        {t("+{n} 更多", { n: evs.length - MAX_PER_DAY })}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function titleText(rec: Rec, titleProp: Prop | undefined): string {
  if (!titleProp) return "";
  const v = rec.cells[titleProp.id];
  return v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
}

function makeGhost(text: string): HTMLElement {
  const g = document.createElement("div");
  g.className = "drag-ghost";
  g.textContent = text || t("移动记录");
  document.body.appendChild(g);
  return g;
}
