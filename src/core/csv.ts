/**
 * Minimal RFC-4180 CSV (no dependency). A cell is quoted only when it must be —
 * it contains a comma, a double quote, or a newline — and embedded quotes are
 * doubled. Parsing is the inverse and tolerates `\r\n`, a trailing newline, and
 * quotes anywhere inside a quoted field.
 */

const NEEDS_QUOTE = /[",\r\n]/;

function encodeCell(value: string): string {
  return NEEDS_QUOTE.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize a grid of strings to CSV text (rows joined with `\n`). */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(encodeCell).join(",")).join("\n");
}

/**
 * Parse CSV text into a grid of strings. A single trailing newline is ignored;
 * an empty input yields no rows.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false; // any char (incl. an empty quoted field) seen on this row

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      started = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      started = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  // Flush the last field/row unless the input ended exactly on a row boundary.
  if (started || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
