/**
 * Relation/doc CSV cell codec. A cell is a ", "-joined list of target titles
 * (raw id per-value fallback) — the form a human reads and edits — kept
 * machine round-trippable by quoting any element the plain join could not
 * invert: titles containing `,` or `"`, starting with `[`/`{` (which would
 * trigger the importer's JSON sniff), or carrying leading/trailing whitespace.
 * Quoting follows the CSV rule (wrap in `"`, double embedded quotes); the
 * outer CSV layer then quotes the whole cell independently — the two layers
 * compose without interfering. Ids never contain any of those characters, so
 * id fallbacks look exactly like the unquoted form.
 */

const NEEDS_QUOTE = /^[\s[{]|[",]|\s$/;

/** Encode a relation/doc cell value (id array) as a readable title list. */
export function encodeRelationCell(value: unknown, titles?: ReadonlyMap<string, string>): string {
  const arr = Array.isArray(value) ? value : value == null ? [] : [value];
  return arr
    .map((v) => {
      const label = titles?.get(String(v)) ?? String(v);
      return NEEDS_QUOTE.test(label) ? `"${label.replace(/"/g, '""')}"` : label;
    })
    .join(", ");
}

/**
 * Decode a relation/doc CSV cell into its element list (titles and/or ids) for
 * per-value resolution. Accepts, in order: a whole-cell JSON array — the
 * legacy export format and the explicit escape hatch for hand-written ids —
 * else a quote-aware ", " split: a `"` at element start opens a quoted element
 * that may contain commas (`""` is a literal quote); unquoted elements are
 * trimmed and empties dropped. Inverse of `encodeRelationCell` for any title.
 */
export function decodeRelationCell(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
    } catch {
      // not JSON after all — fall through to the list scanner
    }
  }
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoted = false; // element was quoted → keep verbatim, no trim
  const push = (): void => {
    const v = quoted ? field : field.trim();
    if (v) out.push(v);
    field = "";
    quoted = false;
  };
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field.trim() === "") {
      inQuotes = true;
      quoted = true;
      field = ""; // drop the pre-quote spaces from the ", " join
    } else if (c === ",") {
      push();
    } else {
      field += c;
    }
  }
  push();
  return out;
}
