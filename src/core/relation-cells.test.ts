import { test, expect } from "bun:test";
import { encodeRelationCell, decodeRelationCell } from "./relation-cells.ts";

const titles = new Map([
  ["rec_a-000001", "Alpha"],
  ["rec_b-000002", "Foo, Bar"],
  ["rec_c-000003", 'He said "hi"'],
  ["rec_d-000004", "[draft] plan"],
  ["rec_e-000005", " padded "],
]);

test("plain titles join unquoted, id fallback for dangling refs", () => {
  expect(encodeRelationCell(["rec_a-000001", "rec_ghost-0000"], titles)).toBe(
    "Alpha, rec_ghost-0000",
  );
  expect(decodeRelationCell("Alpha, rec_ghost-0000")).toEqual(["Alpha", "rec_ghost-0000"]);
});

test("titles containing commas are quoted and survive the round-trip", () => {
  const cell = encodeRelationCell(["rec_b-000002", "rec_a-000001"], titles);
  expect(cell).toBe('"Foo, Bar", Alpha');
  expect(decodeRelationCell(cell)).toEqual(["Foo, Bar", "Alpha"]);
});

test("embedded quotes double CSV-style", () => {
  const cell = encodeRelationCell(["rec_c-000003"], titles);
  expect(cell).toBe('"He said ""hi"""');
  expect(decodeRelationCell(cell)).toEqual(['He said "hi"']);
});

test("leading-bracket and padded titles are quoted so decode cannot misread them", () => {
  expect(decodeRelationCell(encodeRelationCell(["rec_d-000004"], titles))).toEqual([
    "[draft] plan",
  ]);
  expect(decodeRelationCell(encodeRelationCell(["rec_e-000005"], titles))).toEqual([" padded "]);
});

test("decode accepts whole-cell JSON id arrays (legacy / escape hatch)", () => {
  expect(decodeRelationCell('["rec_a-000001","rec_b-000002"]')).toEqual([
    "rec_a-000001",
    "rec_b-000002",
  ]);
});

test("decode trims unquoted elements and drops empties", () => {
  expect(decodeRelationCell(" Alpha ,  , Beta,")).toEqual(["Alpha", "Beta"]);
  expect(decodeRelationCell("")).toEqual([]);
  expect(encodeRelationCell(null, titles)).toBe("");
});

test("round-trip identity over the edge set", () => {
  const ids = [...titles.keys()];
  const labels = ids.map((id) => titles.get(id)!);
  expect(decodeRelationCell(encodeRelationCell(ids, titles))).toEqual(labels);
});
