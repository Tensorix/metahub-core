import { resolveLocale, type Locale } from "./locale.ts";
import { t } from "./t.ts";

export type DateStyle = "date" | "longDate" | "monthDay" | "yearMonth" | "month" | "time" | "dateTime" | "monthDayTime";

const OPTS: Record<Locale, Record<DateStyle, Intl.DateTimeFormatOptions>> = {
  "zh-CN": {
    date: { dateStyle: "medium" },
    longDate: { year: "numeric", month: "long", day: "numeric" },
    monthDay: { month: "long", day: "numeric" },
    yearMonth: { year: "numeric", month: "long" },
    month: { month: "numeric" },
    time: { hour: "2-digit", minute: "2-digit", hour12: false },
    dateTime: { dateStyle: "medium", timeStyle: "short" },
    monthDayTime: { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false },
  },
  en: {
    date: { dateStyle: "medium" },
    longDate: { year: "numeric", month: "long", day: "numeric" },
    monthDay: { month: "short", day: "numeric" },
    yearMonth: { year: "numeric", month: "long" },
    month: { month: "short" },
    time: { hour: "numeric", minute: "2-digit" },
    dateTime: { dateStyle: "medium", timeStyle: "short" },
    monthDayTime: { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  },
};

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: Locale, style: DateStyle): Intl.DateTimeFormat {
  const k = `${locale}/${style}`;
  let f = cache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, OPTS[locale][style]);
    cache.set(k, f);
  }
  return f;
}

export function toDate(v: number | string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

export function fmtDate(v: number | string | Date, style: DateStyle = "date"): string {
  return formatter(resolveLocale(), style).format(toDate(v));
}

export function fmtNumber(n: number): string {
  return n.toLocaleString(resolveLocale());
}

export function fmtRelative(v: number | string | Date, now: number = Date.now()): string {
  const at = toDate(v).getTime();
  const ms = now - at;
  if (ms < 60_000) return t("刚刚");
  if (ms < 3_600_000) return t("{n} 分钟前", { n: Math.floor(ms / 60_000) });
  if (ms < 86_400_000) return t("{n} 小时前", { n: Math.floor(ms / 3_600_000) });
  if (ms < 30 * 86_400_000) return t("{n} 天前", { n: Math.floor(ms / 86_400_000) });
  return fmtDate(at, "date");
}

const MONDAY = new Date(2024, 0, 1);

export function weekdayLabels(): string[] {
  const locale = resolveLocale();
  const f = new Intl.DateTimeFormat(locale, { weekday: locale === "en" ? "short" : "narrow" });
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(2024, 0, MONDAY.getDate() + i)));
}
