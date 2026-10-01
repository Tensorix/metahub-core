/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.tsx";
import { imeGhost } from "./keys.ts";
import { tip } from "./shortcuts.ts";
import { openMenu, closeMenu, type MenuAnchor } from "./ui.tsx";
import { addDays, monthMatrix, parseDate, sameDay, toISO, today } from "./date.ts";
import { fmtDate, weekdayLabels } from "./i18n/fmt.ts";
import { t } from "./i18n/t.ts";

export function openDatePicker(anchor: MenuAnchor, value: unknown, onCommit: (v: string | null) => void, seed?: string) {
  if (anchor instanceof MouseEvent) anchor.stopPropagation();
  openMenu(anchor, (close) => (
    <DatePicker value={value} seed={seed} onPick={(v) => { onCommit(v); close(); }} />
  ), { minWidth: 252 });
}

export function DatePicker({ value, seed, onPick }: {
  value: unknown;
  seed?: string;
  onPick: (v: string | null) => void;
}) {
  const current = parseDate(value);
  const now = today();
  const [text, setText] = useState(seed ?? (current ? toISO(current) : ""));
  const [focus, setFocus] = useState<Date>(current ?? now);
  const [cursor, setCursor] = useState<{ y: number; m: number }>({ y: focus.getFullYear(), m: focus.getMonth() });
  const inputRef = useRef<HTMLInputElement>(null);
  const weekdays = weekdayLabels();

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const typed = parseDate(text.trim());
  useEffect(() => {
    if (!typed) return;
    setFocus(typed);
    setCursor({ y: typed.getFullYear(), m: typed.getMonth() });
  }, [text]);

  const moveFocus = (days: number) => {
    const d = addDays(focus, days);
    setFocus(d);
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
    setText(toISO(d));
  };
  const step = (delta: number) => {
    const m = cursor.m + delta;
    setCursor({ y: cursor.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 });
  };
  const confirm = () => {
    const raw = text.trim();
    if (!raw) return onPick(null);
    const d = parseDate(raw);
    if (d) onPick(toISO(d));
  };
  const invalid = text.trim().length > 0 && !typed;
  const weeks = monthMatrix(cursor.y, cursor.m);

  return (
    <div class="dp">
      <div class={"selsearch" + (invalid ? " invalid" : "")}>
        <Icon name="calendar" cls="ico sm" />
        <input
          ref={inputRef}
          placeholder="YYYY-MM-DD"
          value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (imeGhost(e)) return;
            if (e.key === "ArrowUp") { e.preventDefault(); moveFocus(e.shiftKey ? -7 : -1); }
            else if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(e.shiftKey ? 7 : 1); }
            else if (e.key === "PageUp") { e.preventDefault(); step(-1); }
            else if (e.key === "PageDown") { e.preventDefault(); step(1); }
            else if (e.key === "Enter") { e.preventDefault(); confirm(); }
            else if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
          }}
        />
      </div>
      <div class="dp-nav">
        <button class="iconbtn sm" {...tip(t("上个月"))} onClick={() => step(-1)}><Icon name="chevron" cls="ico sm flip" /></button>
        <span class="dp-title">{fmtDate(new Date(cursor.y, cursor.m, 1), "yearMonth")}</span>
        <button class="iconbtn sm" {...tip(t("下个月"))} onClick={() => step(1)}><Icon name="chevron" cls="ico sm" /></button>
      </div>
      <div class="dp-grid dp-head">
        {weekdays.map((w) => <span key={w}>{w}</span>)}
      </div>
      {weeks.map((week, wi) => (
        <div class="dp-grid" key={wi}>
          {week.map((day) => {
            const dim = day.getMonth() !== cursor.m;
            const cls =
              "dp-day" +
              (dim ? " dim" : "") +
              (sameDay(day, now) ? " today" : "") +
              (current && sameDay(day, current) ? " picked" : "") +
              (sameDay(day, focus) ? " focus" : "");
            return (
              <button key={toISO(day)} class={cls} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(toISO(day))}>
                {day.getDate()}
              </button>
            );
          })}
        </div>
      ))}
      <div class="dp-foot">
        <button class="tbtn" onClick={() => onPick(toISO(now))}>{t("今天")}</button>
        {current && <button class="tbtn" onClick={() => onPick(null)}>{t("清除")}</button>}
        <span class="dp-hint">{t("↑↓ 换日 · ↵ 选定")}</span>
      </div>
    </div>
  );
}
