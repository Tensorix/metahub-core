import type { PropInfo, RecordInfo } from "./api/sdk";
import {
  parseGrid,
  pasteValueFor,
} from "../../../../src/shared/views/table-paste";
export type GridCell = { record: string; prop: string };
export function rectangle(
  records: RecordInfo[],
  props: PropInfo[],
  anchor: GridCell,
  focus: GridCell,
) {
  const a = records.findIndex((r) => r.id === anchor.record),
    b = records.findIndex((r) => r.id === focus.record),
    x = props.findIndex((p) => p.id === anchor.prop),
    y = props.findIndex((p) => p.id === focus.prop);
  if (Math.min(a, b, x, y) < 0) return [];
  return records
    .slice(Math.min(a, b), Math.max(a, b) + 1)
    .map((r) =>
      props
        .slice(Math.min(x, y), Math.max(x, y) + 1)
        .map((p) => ({ record: r.id, prop: p.id })),
    );
}
export function preparePaste(
  text: string,
  records: RecordInfo[],
  props: PropInfo[],
  start: GridCell,
) {
  const row = records.findIndex((r) => r.id === start.record),
    col = props.findIndex((p) => p.id === start.prop);
  if (row < 0 || col < 0) throw new Error("选区已失效");
  const changes: { cell: GridCell; value: unknown }[] = [];
  const grid = parseGrid(text);
  for (let r = 0; r < grid.length; r++)
    for (let c = 0; c < grid[r]!.length; c++) {
      const record = records[row + r],
        prop = props[col + c];
      if (!record || !prop)
        throw new Error("粘贴超出已加载记录或可见字段，请先加载更多记录");
      const raw = grid[r]![c]!;
      if (prop.type === "multi_select" && raw.trim()) {
        const options = (prop.config?.options ?? []).map((v) =>
          v.toLowerCase(),
        );
        const unknown = raw
          .split(/[,，;；、\n]/)
          .map((v) => v.trim())
          .filter(Boolean)
          .find((v) => !options.includes(v.toLowerCase()));
        if (unknown)
          throw new Error(`第 ${r + 1} 行「${prop.name}」未知选项：${unknown}`);
      }
      if (prop.type === "date" && raw.trim()) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
        if (
          !match ||
          new Date(+match[1]!, +match[2]! - 1, +match[3]!).getDate() !==
            +match[3]! ||
          +match[2]! < 1 ||
          +match[2]! > 12
        )
          throw new Error(
            `第 ${r + 1} 行「${prop.name}」请输入有效的 YYYY-MM-DD 日期`,
          );
      }
      const value = pasteValueFor(prop, raw);
      if (!value.ok) throw new Error(`第 ${r + 1} 行「${prop.name}」格式无效`);
      changes.push({
        cell: { record: record.id, prop: prop.id },
        value: value.value,
      });
    }
  return changes;
}
export function serializeGrid(values: unknown[][]) {
  return values
    .map((row) =>
      row
        .map((v) => {
          const text = Array.isArray(v) ? v.join(", ") : String(v ?? "");
          return /["\n\t]/.test(text)
            ? '"' + text.replace(/"/g, '""') + '"'
            : text;
        })
        .join("\t"),
    )
    .join("\n");
}
