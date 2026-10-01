import type { Prop, PropType, Rec } from "./api.ts";
import { addDays, parseDate, startOfMonth, endOfMonth, startOfWeekMon, toISO, today } from "./date.ts";
import { cellText } from "./cells.tsx";
import { t } from "./i18n/t.ts";

export type Layout = "table" | "board" | "calendar" | "timeline";
export type SortRule = { prop: string; desc: boolean };
export type FilterRule = { id: string; prop: string; cond: string; value?: unknown };
export type FilterSet = { op: "and" | "or"; rules: FilterRule[] };
export type CalcKind =
  | "count" | "filled" | "empty" | "sum" | "avg" | "median" | "min" | "max" | "unique" | "checked" | "unchecked";

export interface ViewDef {
  id: string;
  name: string;
  layout: Layout;
  sort: SortRule[];
  filter: FilterSet;
  hidden: string[];
  group?: string;
  dateProp?: string;
  start?: string;
  end?: string | null;
  wrap?: boolean;
  calc?: Record<string, CalcKind>;
}

export const LAYOUTS: Layout[] = ["table", "board", "calendar", "timeline"];
export const LAYOUT_ICON: Record<Layout, string> = { table: "list", board: "group", calendar: "calendar", timeline: "timeline" };
export function layoutLabel(l: Layout): string {
  return l === "table" ? t("表格") : l === "board" ? t("看板") : l === "calendar" ? t("日历") : t("时间轴");
}

export function newViewId(): string {
  return "v_" + Math.random().toString(36).slice(2, 8);
}

export function emptyView(layout: Layout, name?: string, id?: string): ViewDef {
  return { id: id ?? newViewId(), name: name ?? layoutLabel(layout), layout, sort: [], filter: { op: "and", rules: [] }, hidden: [] };
}

/** The views a database shows before anyone saved one: one per layout, with
 *  stable ids so `?view=board` deep links and the old tab order keep working. */
export function defaultViews(): ViewDef[] {
  return LAYOUTS.map((l) => emptyView(l, undefined, `v_${l}`));
}

const isLayout = (x: unknown): x is Layout => typeof x === "string" && (LAYOUTS as string[]).includes(x);

/** Validate a persisted `meta.views` value; anything malformed falls back to
 *  the defaults so a bad write can never blank the database page. */
export function normalizeViews(raw: unknown): ViewDef[] {
  if (!Array.isArray(raw)) return defaultViews();
  const out: ViewDef[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== "string" || !isLayout(o.layout)) continue;
    const sort = Array.isArray(o.sort)
      ? o.sort.filter((s): s is SortRule => !!s && typeof (s as SortRule).prop === "string").map((s) => ({ prop: s.prop, desc: !!s.desc }))
      : [];
    const f = o.filter as Partial<FilterSet> | undefined;
    const rules = Array.isArray(f?.rules)
      ? f!.rules.filter((r): r is FilterRule => !!r && typeof r.prop === "string" && typeof r.cond === "string")
          .map((r, i) => ({ id: typeof r.id === "string" ? r.id : `f${i}`, prop: r.prop, cond: r.cond, value: r.value }))
      : [];
    out.push({
      id: o.id,
      name: typeof o.name === "string" && o.name ? o.name : layoutLabel(o.layout),
      layout: o.layout,
      sort,
      filter: { op: f?.op === "or" ? "or" : "and", rules },
      hidden: Array.isArray(o.hidden) ? o.hidden.filter((h): h is string => typeof h === "string") : [],
      ...(typeof o.group === "string" ? { group: o.group } : {}),
      ...(typeof o.dateProp === "string" ? { dateProp: o.dateProp } : {}),
      ...(typeof o.start === "string" ? { start: o.start } : {}),
      ...(typeof o.end === "string" || o.end === null ? { end: o.end as string | null } : {}),
      ...(typeof o.wrap === "boolean" ? { wrap: o.wrap } : {}),
      ...(o.calc && typeof o.calc === "object" ? { calc: o.calc as Record<string, CalcKind> } : {}),
    });
  }
  return out.length ? out : defaultViews();
}

// ---- filter conditions ------------------------------------------------------

export type CondDef = { id: string; label: string; value: "none" | "text" | "number" | "option" | "options" | "date" | "within" | "bool" | "refs" };

const EMPTY: CondDef[] = [
  { id: "empty", label: t("为空"), value: "none" },
  { id: "not_empty", label: t("不为空"), value: "none" },
];

export function condsFor(type: PropType): CondDef[] {
  switch (type) {
    case "text":
    case "url":
      return [
        { id: "contains", label: t("包含"), value: "text" },
        { id: "not_contains", label: t("不包含"), value: "text" },
        { id: "is", label: t("等于"), value: "text" },
        { id: "is_not", label: t("不等于"), value: "text" },
        ...EMPTY,
      ];
    case "number":
      return [
        { id: "eq", label: "=", value: "number" },
        { id: "ne", label: "≠", value: "number" },
        { id: "gt", label: ">", value: "number" },
        { id: "lt", label: "<", value: "number" },
        { id: "ge", label: "≥", value: "number" },
        { id: "le", label: "≤", value: "number" },
        ...EMPTY,
      ];
    case "select":
      return [
        { id: "is", label: t("是"), value: "option" },
        { id: "is_not", label: t("不是"), value: "option" },
        ...EMPTY,
      ];
    case "multi_select":
      return [
        { id: "has_any", label: t("包含任一"), value: "options" },
        { id: "has_all", label: t("包含全部"), value: "options" },
        { id: "has_none", label: t("都不包含"), value: "options" },
        ...EMPTY,
      ];
    case "date":
      return [
        { id: "is", label: t("是"), value: "date" },
        { id: "before", label: t("早于"), value: "date" },
        { id: "after", label: t("晚于"), value: "date" },
        { id: "on_or_before", label: t("不晚于"), value: "date" },
        { id: "on_or_after", label: t("不早于"), value: "date" },
        { id: "within", label: t("在范围内"), value: "within" },
        ...EMPTY,
      ];
    case "checkbox":
      return [{ id: "is", label: t("是"), value: "bool" }];
    case "relation":
    case "doc":
      return [{ id: "has_any", label: t("包含"), value: "refs" }, ...EMPTY];
  }
}

export const WITHIN_PRESETS: { id: string; label: string }[] = [
  { id: "today", label: t("今天") },
  { id: "this_week", label: t("本周") },
  { id: "this_month", label: t("本月") },
  { id: "past7", label: t("过去 7 天") },
  { id: "next7", label: t("未来 7 天") },
  { id: "past30", label: t("过去 30 天") },
  { id: "next30", label: t("未来 30 天") },
];

export function withinRange(preset: string, now: Date = today()): [Date, Date] {
  switch (preset) {
    case "this_week": { const s = startOfWeekMon(now); return [s, addDays(s, 6)]; }
    case "this_month": return [startOfMonth(now.getFullYear(), now.getMonth()), endOfMonth(now.getFullYear(), now.getMonth())];
    case "past7": return [addDays(now, -6), now];
    case "next7": return [now, addDays(now, 6)];
    case "past30": return [addDays(now, -29), now];
    case "next30": return [now, addDays(now, 29)];
    default: return [now, now];
  }
}

const isEmptyVal = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);
const asArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const asStr = (v: unknown) => (v == null ? "" : String(v));

/** Does one cell satisfy a rule? A rule with no value yet is a no-op (true). */
export function matchRule(rule: FilterRule, prop: Prop, value: unknown, now: Date = today()): boolean {
  const c = rule.cond;
  if (c === "empty") return isEmptyVal(value);
  if (c === "not_empty") return !isEmptyVal(value);
  const rv = rule.value;
  switch (prop.type) {
    case "text":
    case "url": {
      const q = asStr(rv).toLowerCase();
      if (!q) return true;
      const s = asStr(value).toLowerCase();
      if (c === "contains") return s.includes(q);
      if (c === "not_contains") return !s.includes(q);
      if (c === "is") return s === q;
      if (c === "is_not") return s !== q;
      return true;
    }
    case "number": {
      if (rv == null || rv === "") return true;
      const n = Number(rv);
      if (!Number.isFinite(n)) return true;
      const v = value == null || value === "" ? NaN : Number(value);
      if (!Number.isFinite(v)) return c === "ne";
      if (c === "eq") return v === n;
      if (c === "ne") return v !== n;
      if (c === "gt") return v > n;
      if (c === "lt") return v < n;
      if (c === "ge") return v >= n;
      if (c === "le") return v <= n;
      return true;
    }
    case "select": {
      const o = asStr(rv);
      if (!o) return true;
      if (c === "is") return asStr(value) === o;
      if (c === "is_not") return asStr(value) !== o;
      return true;
    }
    case "multi_select":
    case "relation":
    case "doc": {
      const want = asArr(rv);
      if (!want.length) return true;
      const have = asArr(value);
      if (c === "has_any") return want.some((w) => have.includes(w));
      if (c === "has_all") return want.every((w) => have.includes(w));
      if (c === "has_none") return !want.some((w) => have.includes(w));
      return true;
    }
    case "checkbox":
      return c === "is" ? !!value === (rv === true || rv === "true") : true;
    case "date": {
      const d = parseDate(value);
      if (c === "within") {
        const preset = asStr(rv);
        if (!preset) return true;
        if (!d) return false;
        const [s, e] = withinRange(preset, now);
        return d >= s && d <= e;
      }
      const target = parseDate(rv);
      if (!target) return true;
      if (!d) return false;
      const a = d.getTime(), b = target.getTime();
      if (c === "is") return a === b;
      if (c === "before") return a < b;
      if (c === "after") return a > b;
      if (c === "on_or_before") return a <= b;
      if (c === "on_or_after") return a >= b;
      return true;
    }
  }
}

export function applyFilter(records: Rec[], props: Prop[], filter: FilterSet, now: Date = today()): Rec[] {
  const rules = filter.rules
    .map((r) => ({ rule: r, prop: props.find((p) => p.id === r.prop) }))
    .filter((x): x is { rule: FilterRule; prop: Prop } => !!x.prop);
  if (!rules.length) return records;
  return records.filter((rec) => {
    const hits = rules.map(({ rule, prop }) => matchRule(rule, prop, rec.cells[prop.id], now));
    return filter.op === "or" ? hits.some(Boolean) : hits.every(Boolean);
  });
}

// ---- sort -------------------------------------------------------------------

const numOf = (v: unknown) => {
  const n = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
};

export function compareCells(prop: Prop, a: unknown, b: unknown): number {
  switch (prop.type) {
    case "number": return numOf(a) - numOf(b);
    case "checkbox": return Number(!!a) - Number(!!b);
    case "date": return asStr(a).localeCompare(asStr(b));
    case "multi_select":
    case "relation":
    case "doc":
      return asArr(a).join(",").localeCompare(asArr(b).join(","), "zh");
    default:
      return asStr(a).localeCompare(asStr(b), "zh");
  }
}

export function applySort(records: Rec[], props: Prop[], sort: SortRule[]): Rec[] {
  const rules = sort
    .map((s) => ({ s, prop: props.find((p) => p.id === s.prop) }))
    .filter((x): x is { s: SortRule; prop: Prop } => !!x.prop);
  if (!rules.length) return records;
  return [...records].sort((a, b) => {
    for (const { s, prop } of rules) {
      const c = compareCells(prop, a.cells[prop.id], b.cells[prop.id]);
      if (c !== 0) return s.desc ? -c : c;
    }
    return 0;
  });
}

// ---- search -----------------------------------------------------------------

export function searchRecords(records: Rec[], props: Prop[], q: string): Rec[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return records;
  return records.filter((rec) => props.some((p) => cellText(p, rec.cells[p.id]).toLowerCase().includes(needle)));
}

// ---- calculations -----------------------------------------------------------

export function calcKindsFor(type: PropType): CalcKind[] {
  const base: CalcKind[] = ["count", "filled", "empty", "unique"];
  if (type === "number") return [...base, "sum", "avg", "median", "min", "max"];
  if (type === "checkbox") return ["count", "checked", "unchecked"];
  if (type === "date") return [...base, "min", "max"];
  return base;
}

export function calcLabel(k: CalcKind): string {
  switch (k) {
    case "count": return t("计数");
    case "filled": return t("非空");
    case "empty": return t("为空");
    case "unique": return t("唯一值");
    case "sum": return t("求和");
    case "avg": return t("平均");
    case "median": return t("中位数");
    case "min": return t("最小");
    case "max": return t("最大");
    case "checked": return t("已勾选");
    case "unchecked": return t("未勾选");
  }
}

export function computeCalc(k: CalcKind, prop: Prop, values: unknown[]): string {
  const n = values.length;
  const filled = values.filter((v) => !isEmptyVal(v));
  const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, ""));
  const pct = (k2: number) => (n ? `${Math.round((k2 / n) * 100)}%` : "0%");
  switch (k) {
    case "count": return String(n);
    case "filled": return `${filled.length}`;
    case "empty": return `${n - filled.length}`;
    case "unique": return String(new Set(filled.map((v) => JSON.stringify(v))).size);
    case "checked": return pct(values.filter((v) => !!v).length);
    case "unchecked": return pct(values.filter((v) => !v).length);
    case "sum":
    case "avg":
    case "median":
    case "min":
    case "max": {
      if (prop.type === "date") {
        const ds = filled.map((v) => toISO(parseDate(v)!)).filter(Boolean).sort();
        if (!ds.length) return "–";
        return k === "min" ? ds[0]! : k === "max" ? ds[ds.length - 1]! : "–";
      }
      const ns = filled.map(Number).filter(Number.isFinite);
      if (!ns.length) return "–";
      if (k === "sum") return fmt(ns.reduce((a, b) => a + b, 0));
      if (k === "avg") return fmt(ns.reduce((a, b) => a + b, 0) / ns.length);
      if (k === "min") return fmt(Math.min(...ns));
      if (k === "max") return fmt(Math.max(...ns));
      const s = [...ns].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return fmt(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
    }
  }
}
