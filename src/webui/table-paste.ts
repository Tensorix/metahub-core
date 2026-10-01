import type { Prop } from "./api.ts";
import { parseDate, toISO } from "./date.ts";

/** Parse clipboard text into a row-major grid. Tab-separated, newline-delimited;
 *  a cell wrapped in double quotes may contain tabs/newlines ("" escapes a quote),
 *  which is how spreadsheets copy multi-line cells. A single trailing newline is
 *  ignored. */
export function parseGrid(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  const src = text.replace(/\r\n?/g, "\n");
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"' && cell === "") {
      let j = i + 1;
      let out = "";
      let closed = false;
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { out += '"'; j += 2; continue; }
          closed = true; j++; break;
        }
        out += src[j]; j++;
      }
      if (closed && (j >= src.length || src[j] === "\t" || src[j] === "\n")) {
        cell = out;
        i = j;
        continue;
      }
    }
    if (ch === "\t") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
    cell += ch; i++;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  if (rows.length === 0) return [];
  return rows;
}

export type PasteResult = { ok: true; value: unknown } | { ok: false };

const TRUE_RE = /^(true|1|yes|y|是|✓|✔|☑|x|done)$/i;
const FALSE_RE = /^(false|0|no|n|否|☐|)$/i;

function matchOption(options: string[], raw: string): string | null {
  const s = raw.trim();
  if (options.includes(s)) return s;
  const lower = s.toLowerCase();
  return options.find((o) => o.toLowerCase() === lower) ?? null;
}

/** Convert one pasted cell for a property. `ok:false` = leave the cell alone. */
export function pasteValueFor(prop: Prop, raw: string): PasteResult {
  const s = raw.trim();
  switch (prop.type) {
    case "text":
    case "url":
      return { ok: true, value: raw };
    case "number": {
      if (!s) return { ok: true, value: null };
      const n = Number(s.replace(/,/g, ""));
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case "checkbox":
      if (TRUE_RE.test(s)) return { ok: true, value: true };
      if (FALSE_RE.test(s)) return { ok: true, value: false };
      return { ok: false };
    case "date": {
      if (!s) return { ok: true, value: null };
      const d = parseDate(s);
      return d ? { ok: true, value: toISO(d) } : { ok: false };
    }
    case "select": {
      if (!s) return { ok: true, value: null };
      const m = matchOption(prop.config?.options ?? [], s);
      return m ? { ok: true, value: m } : { ok: false };
    }
    case "multi_select": {
      if (!s) return { ok: true, value: [] };
      const options = prop.config?.options ?? [];
      const parts = s.split(/[,，;；、\n]/).map((x) => x.trim()).filter(Boolean);
      const matched: string[] = [];
      for (const p of parts) {
        const m = matchOption(options, p);
        if (m && !matched.includes(m)) matched.push(m);
      }
      return matched.length ? { ok: true, value: matched } : { ok: false };
    }
    default:
      return { ok: false };
  }
}

export type CellPatch = { recId: string; propId: string; value: unknown };

/** Map a pasted grid onto the table starting at (r0, c0). Rows/columns beyond
 *  the table are dropped. Returns the patches to apply plus the count of cells
 *  skipped because the text didn't fit the column's type. */
export function pastePatches(
  grid: string[][],
  rows: { id: string; cells: Record<string, unknown> }[],
  props: Prop[],
  r0: number,
  c0: number,
): { patches: CellPatch[]; skipped: number } {
  const patches: CellPatch[] = [];
  let skipped = 0;
  grid.forEach((line, dr) => {
    const rec = rows[r0 + dr];
    if (!rec) return;
    line.forEach((raw, dc) => {
      const p = props[c0 + dc];
      if (!p) return;
      const res = pasteValueFor(p, raw);
      if (!res.ok) { skipped++; return; }
      if (JSON.stringify(rec.cells[p.id] ?? null) === JSON.stringify(res.value ?? null)) return;
      patches.push({ recId: rec.id, propId: p.id, value: res.value });
    });
  });
  return { patches, skipped };
}
