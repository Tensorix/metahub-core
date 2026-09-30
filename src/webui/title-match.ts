// Local doc/db title matching shared by the `[[` suggest and the palette:
// exact title > prefix (title or id) > substring.
import { allDocTitles } from "./doc-titles.ts";

export interface TitleMatch {
  id: string;
  title: string;
  /** Matched span in `title`; -1 when the id matched instead (or no query). */
  start: number;
  len: number;
}

export function matchTitles(
  query: string,
  limit = 8,
  all: { id: string; title: string }[] = allDocTitles(),
): TitleMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit).map((m) => ({ ...m, start: -1, len: 0 }));
  const exact: TitleMatch[] = [];
  const starts: TitleMatch[] = [];
  const contains: TitleMatch[] = [];
  for (const m of all) {
    const tl = m.title.toLowerCase();
    if (tl === q) exact.push({ ...m, start: 0, len: q.length });
    else if (tl.startsWith(q)) starts.push({ ...m, start: 0, len: q.length });
    else if (m.id.startsWith(q)) starts.push({ ...m, start: -1, len: 0 });
    else {
      const i = tl.indexOf(q);
      if (i >= 0) contains.push({ ...m, start: i, len: q.length });
      else if (m.id.includes(q)) contains.push({ ...m, start: -1, len: 0 });
    }
  }
  return [...exact, ...starts, ...contains].slice(0, limit);
}

export interface Ranked<T> {
  item: T;
  /** Matched span in the item's text; -1 with no query. */
  start: number;
  len: number;
}

/** exact > prefix > substring over arbitrary items; no query keeps the order. */
export function rankMatches<T>(query: string, items: T[], text: (item: T) => string, limit = Infinity): Ranked<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit).map((item) => ({ item, start: -1, len: 0 }));
  const exact: Ranked<T>[] = [];
  const starts: Ranked<T>[] = [];
  const contains: Ranked<T>[] = [];
  for (const item of items) {
    const tl = text(item).toLowerCase();
    if (tl === q) exact.push({ item, start: 0, len: q.length });
    else if (tl.startsWith(q)) starts.push({ item, start: 0, len: q.length });
    else {
      const i = tl.indexOf(q);
      if (i >= 0) contains.push({ item, start: i, len: q.length });
    }
  }
  return [...exact, ...starts, ...contains].slice(0, limit);
}
