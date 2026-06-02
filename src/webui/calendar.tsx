/** @jsxImportSource preact */
// Calendar (month) view: positions records on a month grid by a date property.
// Events can be dragged to another day to reschedule, and days have an inline
// add button that creates a record pre-dated to that day.
import { useRef, useState } from "preact/hooks";
import type { Prop, Rec } from "./api.ts";
import { Icon, TYPE_ICON } from "./icons.tsx";
import { optColor } from "./cells.tsx";
import { openMenu, MenuItem, MenuLabel } from "./ui.tsx";
import { monthMatrix, parseDate, toISO, sameDay, today } from "./date.ts";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const MAX_PER_DAY = 3;

export function CalendarView({
  props,
  records,
  onCommitValue,
  onCreate,
  onOpenRecord,
}: {
  props: Prop[];
  records: Rec[];
  onCommitValue: (rec: Rec, prop: Prop, value: unknown) => void;
  onCreate: (values: Record<string, unknown>) => void;
  onOpenRecord: (id: string) => void;
}) {
  const dateProps = props.filter((p) => p.type === "date");
  const [dateId, setDateId] = useState<string | null>(null);
  const dateProp = props.find((p) => p.id === dateId) ?? dateProps[0] ?? null;
  const now = today();
  const [cursor, setCursor] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() });
  const dragRef = useRef<{ id: string; pointerId: number; startX: number; startY: number; active: boolean; ghost: HTMLElement | null } | null>(null);

  if (!dateProp) {
    return <div class="view-placeholder">日历视图需要一个「日期」属性。请在表格视图中添加一个日期列后再切换到日历。</div>;
  }

  const titleProp = props[0];
  const weeks = monthMatrix(cursor.y, cursor.m);

  // Map each record with a valid date to its day.
  const events = records
    .map((rec) => ({ rec, date: parseDate(rec.values[dateProp.name]) }))
    .filter((e): e is { rec: Rec; date: Date } => e.date != null);
  const eventsOn = (day: Date) => events.filter((e) => sameDay(e.date, day));

  const step = (delta: number) => {
    const m = cursor.m + delta;
    setCursor({ y: cursor.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 });
  };
  const goToday = () => setCursor({ y: now.getFullYear(), m: now.getMonth() });

  const clearDrop = () =>
    document.querySelectorAll(".cal-day.drop-into").forEach((n) => n.classList.remove("drop-into"));

  const startDrag = (e: any, rec: Rec) => {
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
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      d.ghost?.remove();
      document.body.classList.remove("table-dragging");
      clearDrop();
      dragRef.current = null;
      if (!d.active) { onOpenRecord(rec.id); return; } // click without drag → open
      const cell = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".cal-day") as HTMLElement | null;
      const iso = cell?.dataset.iso;
      if (iso && iso !== String(rec.values[dateProp.name] ?? "")) onCommitValue(rec, dateProp, iso);
    };
    addEventListener("pointermove", move, { passive: false });
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  const pickField = (e: MouseEvent) =>
    openMenu(e, (close) => (
      <>
        <MenuLabel>按日期属性</MenuLabel>
        {dateProps.map((p) => (
          <MenuItem key={p.id} icon={TYPE_ICON[p.type]} label={p.name} onClick={() => { setDateId(p.id); close(); }} />
        ))}
      </>
    ));

  return (
    <div class="cal">
      <div class="cal-nav">
        <button class="iconbtn" title="上个月" onClick={() => step(-1)}><Icon name="chevron" cls="ico flip" /></button>
        <div class="cal-title">{cursor.y} 年 {cursor.m + 1} 月</div>
        <button class="iconbtn" title="下个月" onClick={() => step(1)}><Icon name="chevron" cls="ico" /></button>
        <button class="tbtn" onClick={goToday}>今天</button>
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
                  data-iso={iso}
                  key={iso}
                  onClick={(e) => {
                    // Click empty space in the day to add a record dated to it.
                    if ((e.target as HTMLElement).closest(".cal-ev,.cal-add,.cal-more")) return;
                    onCreate({ [dateProp.name]: iso });
                  }}
                >
                  <div class="cal-daynum">
                    <span>{day.getDate()}</span>
                    <button class="cal-add" title="新建记录" onClick={(e) => { e.stopPropagation(); onCreate({ [dateProp.name]: iso }); }}>
                      <Icon name="plus" cls="ico sm" />
                    </button>
                  </div>
                  <div class="cal-events">
                    {evs.slice(0, MAX_PER_DAY).map(({ rec }) => (
                      <div
                        class="cal-ev"
                        key={rec.id}
                        style={{ ["--c" as any]: optColor(titleText(rec, titleProp) || rec.id) }}
                        onPointerDown={(e) => startDrag(e, rec)}
                      >
                        {titleText(rec, titleProp) || "无标题"}
                      </div>
                    ))}
                    {evs.length > MAX_PER_DAY && (
                      <button
                        class="cal-more"
                        onClick={(e) => {
                          e.stopPropagation();
                          openMenu(e, (close) => (
                            <>
                              <MenuLabel>{iso} · {evs.length} 条记录</MenuLabel>
                              {evs.map(({ rec }) => (
                                <MenuItem
                                  key={rec.id}
                                  label={titleText(rec, titleProp) || "无标题"}
                                  onClick={() => { close(); onOpenRecord(rec.id); }}
                                />
                              ))}
                            </>
                          ));
                        }}
                      >
                        +{evs.length - MAX_PER_DAY} 更多
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
  const v = rec.values[titleProp.name];
  return v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
}

function makeGhost(text: string): HTMLElement {
  const g = document.createElement("div");
  g.className = "drag-ghost";
  g.textContent = text || "移动记录";
  document.body.appendChild(g);
  return g;
}
