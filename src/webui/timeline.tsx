/** @jsxImportSource preact */
// Timeline (gantt) view: lays records on a horizontal day axis using a start
// date and an optional end date. Bars span start→end; records with only a start
// render as a single-point milestone. Drag the bar body to shift the whole
// range, or the left/right edge handle to change just the start/end.
import { useRef, useState } from "preact/hooks";
import type { Prop, Rec } from "./api.ts";
import { Icon, TYPE_ICON } from "./icons.tsx";
import { openMenu, MenuItem, MenuLabel, MenuSep } from "./ui.tsx";
import { parseDate, toISO, addDays, daysBetween, today } from "./date.ts";

const SIDE = 200; // px width of the sticky record-name column
const ROW = 36; // px row height
const HEAD = 44; // px axis height
const DAY_PX = 28; // px per day
const PAD = 3; // days of padding on each side of the data range

export function TimelineView({
  props,
  records,
  onCommitValue,
  onOpenRecord,
}: {
  props: Prop[];
  records: Rec[];
  onCommitValue: (rec: Rec, prop: Prop, value: unknown) => void;
  onCreate: (values: Record<string, unknown>) => void;
  onOpenRecord: (id: string) => void;
}) {
  const dateProps = props.filter((p) => p.type === "date");
  const [startId, setStartId] = useState<string | null>(null);
  const [endId, setEndId] = useState<string | null | "none">(null);
  const startProp = props.find((p) => p.id === startId) ?? dateProps[0] ?? null;
  const endProp =
    endId === "none" ? null : (props.find((p) => p.id === endId) ?? dateProps.find((p) => p !== startProp) ?? null);
  const dragRef = useRef<{ pointerId: number; startX: number } | null>(null);
  const guideRef = useRef<HTMLDivElement>(null);

  if (!startProp) {
    return <div class="view-placeholder">时间轴视图需要一个「日期」属性作为开始日期。请在表格视图中添加一个日期列后再切换到时间轴。</div>;
  }

  const titleProp = props[0];
  const now = today();

  // Resolve each record's start/end days.
  const rows = records.map((rec) => {
    const s = parseDate(rec.values[startProp.name]);
    const e = endProp ? parseDate(rec.values[endProp.name]) : null;
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
  const rangeStart = addDays(min, -PAD);
  const rangeEnd = addDays(max, PAD);
  const totalDays = daysBetween(rangeStart, rangeEnd) + 1;
  const canvasW = SIDE + totalDays * DAY_PX;
  const xForOffset = (o: number) => SIDE + o * DAY_PX;
  const todayOffset = daysBetween(rangeStart, now);

  const days: Date[] = [];
  for (let i = 0; i < totalDays; i++) days.push(addDays(rangeStart, i));

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
    if (ev.button !== 0 || !s) return;
    ev.preventDefault();
    ev.stopPropagation();
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
      const dxDays = Math.round((e2.clientX - d.startX) / DAY_PX);
      if (Math.abs(e2.clientX - d.startX) > 3) moved = true;
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
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      dragRef.current = null;
      grip?.classList.remove("dragging");
      hideGuide();
      const dxDays = Math.round((e2.clientX - d.startX) / DAY_PX);
      if (!moved) { onOpenRecord(rec.id); return; }
      commitDelta(rec, s, e, mode, dxDays);
    };
    addEventListener("pointermove", move, { passive: false });
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
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
        <MenuLabel>开始日期</MenuLabel>
        {dateProps.map((p) => (
          <MenuItem key={p.id} icon={TYPE_ICON[p.type]} label={p.name} checked={p === startProp} onClick={() => { setStartId(p.id); close(); }} />
        ))}
        <MenuSep />
        <MenuLabel>结束日期（可选）</MenuLabel>
        <MenuItem icon="x" label="无（里程碑）" checked={!endProp} onClick={() => { setEndId("none"); close(); }} />
        {dateProps.map((p) => (
          <MenuItem key={p.id} icon={TYPE_ICON[p.type]} label={p.name} checked={p === endProp} onClick={() => { setEndId(p.id); close(); }} />
        ))}
      </>
    ));

  return (
    <div class="tl">
      <div class="tl-toolbar">
        <button class="tbtn" onClick={pickField}>
          <Icon name="timeline" cls="ico sm" />
          {startProp.name}{endProp ? ` → ${endProp.name}` : "（里程碑）"}
        </button>
      </div>
      <div class="tl-scroll">
        <div class="tl-canvas" style={{ width: canvasW, height: HEAD + rows.length * ROW + 8 }}>
          <div class="tl-axis" style={{ height: HEAD }}>
            <div class="tl-corner" style={{ width: SIDE }}>记录</div>
            {days.map((d, i) => {
              const first = d.getDate() === 1;
              return (
                <div
                  class={"tl-tick" + (first ? " mstart" : "") + (daysBetween(d, now) === 0 ? " today" : "")}
                  key={i}
                  style={{ left: xForOffset(i), width: DAY_PX }}
                >
                  {first && <span class="tl-month">{d.getMonth() + 1}月</span>}
                  <span class="tl-dnum">{d.getDate()}</span>
                </div>
              );
            })}
          </div>

          {rows.map(({ rec, s, e }, ri) => {
            const offset = s ? daysBetween(rangeStart, s) : 0;
            const span = s && e ? daysBetween(s, e) + 1 : 1;
            return (
              <div class="tl-row" key={rec.id} style={{ top: HEAD + ri * ROW, height: ROW }}>
                <div class="tl-rowlabel" style={{ width: SIDE }}>{titleText(rec, titleProp) || <span class="muted">无标题</span>}</div>
                {!s ? (
                  <div class="tl-track-empty" style={{ left: SIDE }} onClick={(ev) => placeAt(ev, rec)} title="点击空白处排期">
                    <button class="tl-schedule" style={{ left: SIDE + 8 }} onClick={(ev) => { ev.stopPropagation(); scheduleStart(rec, now); }}>
                      未排期 · 排到今天
                    </button>
                  </div>
                ) : e ? (
                  <div
                    class="tl-item"
                    style={{ left: xForOffset(offset), width: span * DAY_PX }}
                    onPointerDown={(ev) => startDrag(ev, rec, s, e, "move", ev.currentTarget as HTMLElement)}
                  >
                    <span class="tl-h l" onPointerDown={(ev) => startDrag(ev, rec, s, e, "l", (ev.currentTarget as HTMLElement).parentElement as HTMLElement)} />
                    <span class="tl-label">{titleText(rec, titleProp)}</span>
                    <span class="tl-h r" onPointerDown={(ev) => startDrag(ev, rec, s, e, "r", (ev.currentTarget as HTMLElement).parentElement as HTMLElement)} />
                  </div>
                ) : (
                  <div
                    class="tl-milestone"
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
  const v = rec.values[titleProp.name];
  return v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
}
