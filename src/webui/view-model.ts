import { normalizeViews as normalizeSharedViews } from "../shared/views/model.ts";
import type { Prop, PropType, Rec } from "./api.ts";
import { parseDate, toISO } from "./date.ts";
import { cellText } from "./cells.tsx";
import { t } from "./i18n/t.ts";

export type Layout = "table" | "board" | "calendar" | "timeline";
export type SortRule = { prop: string; desc: boolean };
export type FilterRule = { id: string; prop: string; cond: string; value?: unknown };
export type FilterSet = { op: "and" | "or"; rules: FilterRule[] };
export type CalcKind =
  | "count" | "filled" | "empty" | "sum" | "avg" | "median" | "min" | "max" | "unique" | "checked" | "unchecked";

export interface ViewDef {
  [key: string]: unknown;
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

export function normalizeViews(raw: unknown): ViewDef[] {
  return normalizeSharedViews(raw, layoutLabel);
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

export { withinRange, matchRule, applyFilter, compareCells, applySort } from "../shared/views/model.ts";

const isEmptyVal = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

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
