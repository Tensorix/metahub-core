import { expect, test } from "bun:test";
import { preparePaste, rectangle, serializeGrid } from "./grid-selection";
import type { PropInfo, RecordInfo } from "./api/sdk";
const props: PropInfo[] = [
  {
    id: "t",
    database_id: "d",
    name: "文本",
    type: "text",
    config: null,
    position: 0,
  },
  {
    id: "n",
    database_id: "d",
    name: "数字",
    type: "number",
    config: null,
    position: 1,
  },
];
const rows: RecordInfo[] = [
  { id: "a", database_id: "d", cells: { t: "a", n: 1 }, values: {} },
  { id: "b", database_id: "d", cells: { t: "b", n: 2 }, values: {} },
];
test("reverse rectangle keeps row and visible column order", () => {
  expect(
    rectangle(
      rows,
      props,
      { record: "b", prop: "n" },
      { record: "a", prop: "t" },
    ),
  ).toEqual([
    [
      { record: "a", prop: "t" },
      { record: "a", prop: "n" },
    ],
    [
      { record: "b", prop: "t" },
      { record: "b", prop: "n" },
    ],
  ]);
});
test("paste validates entire payload before returning any writes", () => {
  expect(() =>
    preparePaste("good\t1\nbad\tNaN", rows, props, { record: "a", prop: "t" }),
  ).toThrow("第 2 行");
  expect(rows[0]!.cells.n).toBe(1);
});
test("quoted multiline clipboard roundtrips and overflow is explicit", () => {
  const text = serializeGrid([['hello\n"world"', 4]]);
  expect(
    preparePaste(text, rows, props, { record: "a", prop: "t" }).map(
      (c) => c.value,
    ),
  ).toEqual(['hello\n"world"', 4]);
  expect(() =>
    preparePaste("1\t2\t3", rows, props, { record: "a", prop: "t" }),
  ).toThrow("超出");
});

test("unknown multiselect options and impossible dates reject the whole paste", () => {
  const options = {
    ...props[0]!,
    type: "multi_select" as const,
    config: { options: ["A", "B"] },
  };
  expect(() =>
    preparePaste("A,unknown", rows, [options], { record: "a", prop: "t" }),
  ).toThrow("未知选项");
  const date = { ...props[0]!, type: "date" as const };
  expect(() =>
    preparePaste("2026-02-30", rows, [date], { record: "a", prop: "t" }),
  ).toThrow("有效");
});
