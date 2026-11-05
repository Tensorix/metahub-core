import type { ViewDef } from "../../../../../src/shared/views/model.ts";

/** Preserve unknown layouts, view keys and concurrent local view edits. */
export function mergeView(
  raw: unknown,
  fallback: ViewDef[],
  next: ViewDef,
): unknown[] {
  const views = Array.isArray(raw) ? raw : fallback;
  const found = views.some(
    (v) =>
      !!v && typeof v === "object" && (v as { id?: string }).id === next.id,
  );
  return found
    ? views.map((value) => {
        if (
          !value ||
          typeof value !== "object" ||
          (value as { id?: string }).id !== next.id
        )
          return value;
        const current = value as Record<string, unknown>;
        const filter =
          current.filter && typeof current.filter === "object"
            ? (current.filter as Record<string, unknown>)
            : {};
        const oldSort = Array.isArray(current.sort) ? current.sort : [];
        const oldRules = Array.isArray(filter.rules) ? filter.rules : [];
        return {
          ...current,
          name: next.name,
          layout: next.layout,
          hidden: next.hidden,
          group: next.group,
          sort: next.sort.map((rule) => {
            const old = oldSort.find(
              (v) => !!v && typeof v === "object" && v.prop === rule.prop,
            );
            return { ...(old ?? rule), prop: rule.prop, desc: rule.desc };
          }),
          filter: {
            ...filter,
            op: next.filter.op,
            rules: next.filter.rules.map((rule) => {
              const old = oldRules.find(
                (v) => !!v && typeof v === "object" && v.id === rule.id,
              );
              return {
                ...(old ?? rule),
                id: rule.id,
                prop: rule.prop,
                cond: rule.cond,
                value: rule.value,
              };
            }),
          },
        };
      })
    : [...views, next];
}
export function manualOrderAllowed(
  search: string,
  rules: unknown[],
  sort: unknown[],
): boolean {
  return !search.trim() && rules.length === 0 && sort.length === 0;
}
/** Find a real neighboring anchor; page edges use a separately queried adjacent page. */
export function adjacentAnchor<T extends { id: string }>(
  records: T[],
  id: string,
  direction: "up" | "down",
  previous?: T,
  next?: T,
): T | undefined {
  const index = records.findIndex((r) => r.id === id);
  if (index < 0) return undefined;
  return direction === "up"
    ? (records[index - 1] ?? previous)
    : (records[index + 1] ?? next);
}

/** Find visible neighbors in canonical order, including column neighbors beyond this page. */
export async function findManualNeighbor<T extends { id: string }>(
  fetchPage: (offset: number) => Promise<{ records: T[]; hasMore: boolean }>,
  id: string,
  direction: "up" | "down",
  matches: (record: T) => boolean,
  isCurrent = () => true,
): Promise<T | undefined> {
  let previous: T | undefined,
    found = false;
  for (let offset = 0; ;) {
    if (!isCurrent()) throw new Error("工作区已切换，请重新打开数据库");
    const page = await fetchPage(offset);
    if (!isCurrent()) throw new Error("工作区已切换，请重新打开数据库");
    for (const record of page.records) {
      if (!matches(record)) continue;
      if (record.id === id) {
        if (direction === "up") return previous;
        found = true;
        continue;
      }
      if (found) return record;
      previous = record;
    }
    if (!page.hasMore || !page.records.length) return undefined;
    offset += page.records.length;
  }
}

export function validPageOffset(
  offset: number,
  total: number,
  limit: number,
): number {
  return Math.min(offset, Math.max(0, Math.floor((total - 1) / limit) * limit));
}
