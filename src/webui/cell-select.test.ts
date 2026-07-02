import { test, expect } from "bun:test";
import { normRect, inRect, edgeShadow, selectionToTsv, moveCellSel, clearRect, type CellSel } from "./cell-select.ts";

const sel = (ar: number, ac: number, br: number, bc: number): CellSel => ({ a: { r: ar, c: ac }, b: { r: br, c: bc } });

test("normRect normalizes any anchor/focus corner into min/max bounds", () => {
  const want = { r0: 1, r1: 3, c0: 2, c1: 4 };
  expect(normRect(sel(1, 2, 3, 4))).toEqual(want); // top-left → bottom-right
  expect(normRect(sel(3, 4, 1, 2))).toEqual(want); // bottom-right → top-left
  expect(normRect(sel(3, 2, 1, 4))).toEqual(want); // bottom-left → top-right
  expect(normRect(sel(1, 4, 3, 2))).toEqual(want); // top-right → bottom-left
});

test("normRect of a single cell is a 1x1 rect", () => {
  expect(normRect(sel(2, 2, 2, 2))).toEqual({ r0: 2, r1: 2, c0: 2, c1: 2 });
});

test("inRect covers interior, edges, and excludes outside", () => {
  const rect = normRect(sel(1, 1, 3, 3));
  expect(inRect(rect, 2, 2)).toBe(true); // interior
  expect(inRect(rect, 1, 1)).toBe(true); // corner
  expect(inRect(rect, 1, 3)).toBe(true); // edge
  expect(inRect(rect, 0, 2)).toBe(false); // above
  expect(inRect(rect, 4, 2)).toBe(false); // below
  expect(inRect(rect, 2, 4)).toBe(false); // right of
});

test("edgeShadow draws all four insets for a single-cell selection", () => {
  const rect = normRect(sel(0, 0, 0, 0));
  const s = edgeShadow(rect, 0, 0)!;
  expect(s).toContain("inset 0 2px 0 0 var(--accent)"); // top
  expect(s).toContain("inset 0 -2px 0 0 var(--accent)"); // bottom
  expect(s).toContain("inset 2px 0 0 0 var(--accent)"); // left
  expect(s).toContain("inset -2px 0 0 0 var(--accent)"); // right
});

test("edgeShadow gives the four corners exactly two edges each", () => {
  const rect = normRect(sel(0, 0, 2, 2)); // 3x3
  expect(edgeShadow(rect, 0, 0)).toBe("inset 0 2px 0 0 var(--accent),inset 2px 0 0 0 var(--accent)"); // top-left
  expect(edgeShadow(rect, 2, 2)).toBe("inset 0 -2px 0 0 var(--accent),inset -2px 0 0 0 var(--accent)"); // bottom-right
});

test("edgeShadow gives an edge (non-corner) cell exactly one inset", () => {
  const rect = normRect(sel(0, 0, 2, 2)); // 3x3
  expect(edgeShadow(rect, 0, 1)).toBe("inset 0 2px 0 0 var(--accent)"); // top edge, middle column
  expect(edgeShadow(rect, 1, 0)).toBe("inset 2px 0 0 0 var(--accent)"); // left edge, middle row
});

test("edgeShadow returns undefined for the interior and for outside cells", () => {
  const rect = normRect(sel(0, 0, 2, 2)); // 3x3
  expect(edgeShadow(rect, 1, 1)).toBeUndefined(); // interior has no edge
  expect(edgeShadow(rect, 5, 5)).toBeUndefined(); // outside
});

test("selectionToTsv emits a rectangular slice tab/newline separated, verbatim", () => {
  const rows = [
    ["h1", "h2", "h3"],
    ["a | b", "c", "d"], // pipes are NOT escaped — TSV is literal text
    ["e", "f", "  g  "], // surrounding spaces preserved
  ];
  expect(selectionToTsv(rows, normRect(sel(0, 0, 1, 1)))).toBe("h1\th2\na | b\tc");
  expect(selectionToTsv(rows, normRect(sel(1, 0, 2, 2)))).toBe("a | b\tc\td\ne\tf\t  g  ");
});

test("selectionToTsv fills missing cells with empty strings", () => {
  const rows = [["a"], ["b", "c"]]; // ragged rows
  expect(selectionToTsv(rows, normRect(sel(0, 0, 1, 1)))).toBe("a\t\nb\tc");
});

test("moveCellSel: plain arrow collapses to the target cell", () => {
  expect(moveCellSel(sel(1, 1, 1, 1), "ArrowRight", false, 3, 3)).toEqual(sel(1, 2, 1, 2));
  expect(moveCellSel(sel(1, 1, 1, 1), "ArrowDown", false, 3, 3)).toEqual(sel(2, 1, 2, 1));
  // a multi-cell rect collapses onto the moved focus, dropping the anchor
  expect(moveCellSel(sel(0, 0, 2, 2), "ArrowUp", false, 3, 3)).toEqual(sel(1, 2, 1, 2));
});

test("moveCellSel: shift extends by moving only the focus corner", () => {
  expect(moveCellSel(sel(0, 0, 1, 1), "ArrowDown", true, 3, 3)).toEqual(sel(0, 0, 2, 1));
  expect(moveCellSel(sel(2, 2, 1, 1), "ArrowLeft", true, 3, 3)).toEqual(sel(2, 2, 1, 0));
});

test("moveCellSel clamps to the grid on every edge", () => {
  expect(moveCellSel(sel(0, 0, 0, 0), "ArrowUp", false, 3, 3)).toEqual(sel(0, 0, 0, 0));
  expect(moveCellSel(sel(0, 0, 0, 0), "ArrowLeft", true, 3, 3)).toEqual(sel(0, 0, 0, 0));
  expect(moveCellSel(sel(2, 2, 2, 2), "ArrowDown", false, 3, 3)).toEqual(sel(2, 2, 2, 2));
  expect(moveCellSel(sel(0, 0, 2, 2), "ArrowRight", true, 3, 3)).toEqual(sel(0, 0, 2, 2));
});

test("moveCellSel returns null for non-arrow keys and degenerate grids", () => {
  expect(moveCellSel(sel(0, 0, 0, 0), "Enter", false, 3, 3)).toBeNull();
  expect(moveCellSel(sel(0, 0, 0, 0), "c", false, 3, 3)).toBeNull();
  expect(moveCellSel(sel(0, 0, 0, 0), "ArrowDown", false, 0, 0)).toBeNull();
});

test("clearRect blanks the rect and leaves everything else untouched", () => {
  const rows = [
    ["h1", "h2", "h3"],
    ["a", "b", "c"],
    ["d", "e", "f"],
  ];
  const next = clearRect(rows, normRect(sel(1, 1, 2, 2)));
  expect(next).toEqual([
    ["h1", "h2", "h3"],
    ["a", "", ""],
    ["d", "", ""],
  ]);
  // pure: the input grid is not mutated
  expect(rows[1]).toEqual(["a", "b", "c"]);
});

test("clearRect on a single-cell rect clears exactly one cell", () => {
  expect(clearRect([["a", "b"]], normRect(sel(0, 1, 0, 1)))).toEqual([["a", ""]]);
});
