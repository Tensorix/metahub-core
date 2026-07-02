// ---- shared cell range selection geometry ----
// Pure helpers for rectangular cell selection, shared by the database grid
// (table.tsx) and the document table block (editor.tsx TableBlock). DOM-driven
// drag/keyboard logic lives at each call site (the cell DOM differs: td.cell-td
// vs .doc-td); only the geometry + serialization is shared here.

export type CellPos = { r: number; c: number }; // r = row index, c = column index
export type CellSel = { a: CellPos; b: CellPos }; // a = anchor, b = focus
export type CellRect = { r0: number; r1: number; c0: number; c1: number };

// Normalize an anchor/focus pair into an inclusive rectangle (anchor may sit at
// any corner, so min/max each axis).
export function normRect(s: CellSel): CellRect {
  return {
    r0: Math.min(s.a.r, s.b.r), r1: Math.max(s.a.r, s.b.r),
    c0: Math.min(s.a.c, s.b.c), c1: Math.max(s.a.c, s.b.c),
  };
}

export function inRect(rect: CellRect, r: number, c: number): boolean {
  return r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1;
}

// Accent rectangle outline drawn via inset box-shadow on the cells that sit on
// the selection's edges — top/bottom/left/right each contribute one inset edge,
// so a single cell gets all four and the interior gets none. Returns undefined
// when the cell is outside the rect (no outline).
export function edgeShadow(rect: CellRect, r: number, c: number): string | undefined {
  if (!inRect(rect, r, c)) return undefined;
  const parts: string[] = [];
  if (r === rect.r0) parts.push("inset 0 2px 0 0 var(--accent)");
  if (r === rect.r1) parts.push("inset 0 -2px 0 0 var(--accent)");
  if (c === rect.c0) parts.push("inset 2px 0 0 0 var(--accent)");
  if (c === rect.c1) parts.push("inset -2px 0 0 0 var(--accent)");
  return parts.join(",") || undefined;
}

// Arrow-key step for a cell selection over an nrows×ncols grid: the focus
// corner moves one cell (clamped to the grid); Shift keeps the anchor (extend),
// a plain arrow collapses to the target cell. Returns null for non-arrow keys
// so callers can fall through to other bindings.
export function moveCellSel(
  sel: CellSel, key: string, shift: boolean, nrows: number, ncols: number,
): CellSel | null {
  const ARROWS: Record<string, [number, number]> = {
    ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
  };
  const d = ARROWS[key];
  if (!d || nrows < 1 || ncols < 1) return null;
  const clamp = (n: number, hi: number) => Math.max(0, Math.min(hi, n));
  const b = { r: clamp(sel.b.r + d[0], nrows - 1), c: clamp(sel.b.c + d[1], ncols - 1) };
  return shift ? { a: sel.a, b } : { a: b, b };
}

// Blank out every cell inside the rect (returns a new row-major grid; rows and
// cells outside the rect are carried over untouched).
export function clearRect(rows: string[][], rect: CellRect): string[][] {
  return rows.map((row, r) => row.map((cell, c) => (inRect(rect, r, c) ? "" : cell)));
}

// Serialize a rectangular slice of a row-major grid into TSV (tab between
// columns, newline between rows) — pastes back into spreadsheets as a table.
// Cells are emitted verbatim; out-of-range indices yield empty strings.
export function selectionToTsv(rows: string[][], rect: CellRect): string {
  const out: string[] = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    const row = rows[r] ?? [];
    const cells: string[] = [];
    for (let c = rect.c0; c <= rect.c1; c++) cells.push(row[c] ?? "");
    out.push(cells.join("\t"));
  }
  return out.join("\n");
}
