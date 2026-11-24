import type { DatabaseQueryWindow, QueryIndex } from "../shared/views/database-source";
import { api, type Prop, type Rec } from "./api";
import { cellText, colWidth, referenceLabel } from "./cells";
import type { CellRect } from "./cell-select";
import { t } from "./i18n/t";
import { assertTableImageSize, type TableImageCell, type TableImageData } from "./table-image";
import { calcLabel, type ViewDef } from "./view-model";

export type DatabaseImageSelection = { rect?: CellRect; checked?: ReadonlySet<string> };

/** Preserve query order even when checked records have scrolled out of the page cache. */
async function checkedRecords(
  query: DatabaseQueryWindow, index: QueryIndex, checked: ReadonlySet<string>,
): Promise<Rec[]> {
  if (index.total <= checked.size * 2) {
    return (await query.readRange(0, index.total)).filter(row => checked.has(row.id));
  }
  const found = new Map<string, { position: number; row: Rec }>();
  query.rows().forEach((row, position) => {
    if (checked.has(row.id)) found.set(row.id, { position, row });
  });
  for (const id of checked) {
    if (found.has(id)) continue;
    const position = await api.locateRecordQuery(index.id, id);
    if (position < 0) continue; // A later filter can hide a checked row.
    const [row] = (await api.readRecordQuery(index.id, position, 1)).records;
    if (row?.id !== id) throw new Error(t("视图已更新，请重新复制"));
    found.set(id, { position, row });
  }
  return [...found.values()].sort((a, b) => a.position - b.position).map(entry => entry.row);
}

async function formatColumn(prop: Prop, records: Rec[]): Promise<TableImageCell[]> {
  const values = records.map(row => row.cells[prop.id]);
  if (prop.type === "checkbox") return values.map(value => ({ checked: !!value }));
  if (prop.type === "select") return values.map(value => value == null || value === "" ? "" : { chips: [String(value)] });
  if (prop.type === "multi_select") return values.map(value => Array.isArray(value) ? { chips: value.map(String) } : cellText(prop, value));
  if (prop.type !== "doc" && prop.type !== "relation") return values.map(value => cellText(prop, value));

  const references = values.map(value => Array.isArray(value) ? value.map(String) : []);
  const ids = [...new Set(references.flat())];
  const labels = new Map<string, string>();
  if (ids.length && (prop.type === "doc" || prop.config?.database)) {
    const summaries = await api.referenceSummaries({
      kind: prop.type === "doc" ? "document" : "record",
      databaseId: prop.type === "relation" ? prop.config?.database : undefined,
      ids,
    });
    for (const { id, title, missing } of summaries) {
      labels.set(id, referenceLabel(id, prop.type === "doc" && !missing ? title ?? "" : title));
    }
  }
  return references.map(refs => ({ chips: refs.map(id => labels.get(id) ?? referenceLabel(id, null)) }));
}

export async function databaseTableImage(
  query: DatabaseQueryWindow, queryId: string, visible: Prop[], calc: ViewDef["calc"],
  { rect, checked }: DatabaseImageSelection = {},
): Promise<TableImageData> {
  const index = await query.completeIndex();
  if (index.id !== queryId) throw new Error(t("视图已更新，请重新复制"));
  const columns = rect ? visible.slice(rect.c0, rect.c1 + 1) : visible;
  const start = rect?.r0 ?? 0;
  const end = rect ? Math.min(rect.r1 + 1, index.total) : index.total;
  const hasFooter = !rect && !checked && columns.some(p => calc?.[p.id]);
  const count = checked ? Math.min(checked.size, index.total) : end - start;
  assertTableImageSize(count + Number(!rect) + Number(hasFooter), columns.length);
  const records = checked ? await checkedRecords(query, index, checked) : await query.readRange(start, end);
  if (checked && !records.length) throw new Error(t("当前视图中没有选中的记录"));
  if ((!checked && records.length !== end - start) || query.index?.id !== queryId)
    throw new Error(t("视图已更新，请重新复制"));
  const values = await Promise.all(columns.map(prop => formatColumn(prop, records)));
  const rows = records.map((_, i) => values.map(column => column[i]!));
  if (!rect) rows.unshift(columns.map(p => p.name));
  if (hasFooter) rows.push(columns.map(p => calc?.[p.id] ? `${calcLabel(calc[p.id]!)} ${index.calc[p.id] ?? ""}`.trim() : ""));
  return {
    rows, headerRow: !rect, widths: columns.map(colWidth),
    align: columns.map(p => p.type === "number" ? "right" : p.type === "checkbox" ? "center" : "left"),
  };
}
