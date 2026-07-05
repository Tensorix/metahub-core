// Single source of truth for the constrained inline-markdown grammar.
//
// Four surfaces render the same inline syntax — the CM6 live editor
// (webui/cm6/inline.ts), the contenteditable/table HTML bridge
// (webui/markdown.tsx), the TOC label stripper (webui/cm6/chrome/toc.tsx), and
// the share renderer (core/sync/share-render.ts) — and they had drifted apart.
// They all consume this tokenizer now, so the grammar can only change in one
// place. Pure string ops (no DOM): lives in core so the share SSR and the
// static E2EE share shell can use it too.
//
// Semantics (deliberately simple, single level — no nested emphasis):
//   `code`   — content is literal; protects its interior from every other rule
//   ![a](u)  — inline image; MUST outrank the link rule (it contains one)
//   **b**/__b__  ~~d~~  *i*/_i_  [t](u)
// Candidates are collected per pattern and selected greedily left-to-right with
// a priority rank on start-ties, exactly like the CM6 editor always did — so a
// chosen span swallows anything overlapping it (`` `**x**` `` is one code token).
//
// Escapes (v1): a backslash immediately before a delimiter prevents the token
// (`\*not em\*` stays literal); the backslash itself remains literal text —
// no unescaping pass. Escapes do not apply inside code spans (CommonMark-like).

export interface InlineToken {
  kind: "code" | "image" | "strong" | "em" | "del" | "link";
  /** Token span in the source string (end exclusive), delimiters included. */
  start: number;
  end: number;
  /** Content span (code text, emphasis body, link text, image alt). */
  innerFrom: number;
  innerTo: number;
  /** link / image only. */
  url?: string;
  /** image only (may be ""). */
  alt?: string;
}

interface Pattern {
  kind: InlineToken["kind"];
  re: RegExp;
  /** Delimiter width on each side (symmetric tokens only). */
  delim: number;
  /** Lower wins when two candidates start at the same offset. */
  rank: number;
}

// Boundary guards ((?<![*\w]) …) are inherited from the original CM6 grammar;
// the (?<!\\) guards close the escape hole shared by all three old copies.
// Content classes exclude \n so tokens never span lines; URLs exclude
// whitespace so a pasted sentence in parens doesn't become a link target.
const PATTERNS: Pattern[] = [
  { kind: "code", re: /(?<!\\)`([^`\n]+)`/g, delim: 1, rank: 0 },
  { kind: "image", re: /(?<!\\)!\[([^\]\n]*)\]\(([^)\s]+)\)/g, delim: 0, rank: 1 },
  { kind: "strong", re: /(?<!\\)\*\*([^*\n]+?)(?<!\\)\*\*/g, delim: 2, rank: 2 },
  { kind: "strong", re: /(?<!\\)__([^_\n]+?)(?<!\\)__/g, delim: 2, rank: 2 },
  { kind: "del", re: /(?<!\\)~~([^~\n]+?)(?<!\\)~~/g, delim: 2, rank: 3 },
  { kind: "em", re: /(?<![*\w])(?<!\\)\*([^*\n]+?)(?<!\\)\*(?!\*)/g, delim: 1, rank: 4 },
  { kind: "em", re: /(?<![_\w])(?<!\\)_([^_\n]+?)(?<!\\)_(?!_)/g, delim: 1, rank: 4 },
  { kind: "link", re: /(?<!\\)\[([^\]\n]+)\]\(([^)\s]+)\)/g, delim: 0, rank: 5 },
];

interface Cand extends InlineToken {
  rank: number;
}

/** Tokenize one inline string. Returns non-overlapping tokens sorted by start. */
export function tokenizeInline(text: string): InlineToken[] {
  if (!text) return [];
  const cands: Cand[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text))) {
      const start = m.index;
      const end = start + m[0]!.length;
      let innerFrom: number;
      let innerTo: number;
      let url: string | undefined;
      let alt: string | undefined;
      if (p.kind === "link") {
        innerFrom = start + 1;
        innerTo = start + 1 + m[1]!.length;
        url = m[2]!;
      } else if (p.kind === "image") {
        innerFrom = start + 2; // after `![`
        innerTo = start + 2 + m[1]!.length;
        url = m[2]!;
        alt = m[1]!;
      } else {
        innerFrom = start + p.delim;
        innerTo = end - p.delim;
        if (innerTo <= innerFrom) continue;
      }
      cands.push({ kind: p.kind, start, end, innerFrom, innerTo, url, alt, rank: p.rank });
    }
  }
  // Greedy left-to-right, single level: earliest start wins; on a start-tie the
  // higher-priority (lower rank) pattern wins, then the longer match.
  cands.sort((a, b) => a.start - b.start || a.rank - b.rank || b.end - a.end);
  const out: InlineToken[] = [];
  let cursor = 0;
  for (const c of cands) {
    if (c.start < cursor) continue; // overlaps a chosen span
    cursor = c.end;
    out.push({
      kind: c.kind,
      start: c.start,
      end: c.end,
      innerFrom: c.innerFrom,
      innerTo: c.innerTo,
      ...(c.url !== undefined ? { url: c.url } : {}),
      ...(c.alt !== undefined ? { alt: c.alt } : {}),
    });
  }
  return out;
}

/** Reduce a string to its plain text: delimiters dropped, links/images keep
 *  their text/alt. Runs to a fixed point so `[**b**](u)` fully flattens even
 *  though a single tokenize pass is single-level. Used for TOC labels etc. */
export function stripInlineTokens(text: string): string {
  let s = text;
  for (let i = 0; i < 8; i++) {
    const tokens = tokenizeInline(s);
    if (!tokens.length) break;
    let out = "";
    let pos = 0;
    for (const t of tokens) {
      out += s.slice(pos, t.start);
      out += t.kind === "image" ? (t.alt ?? "") : s.slice(t.innerFrom, t.innerTo);
      pos = t.end;
    }
    out += s.slice(pos);
    if (out === s) break;
    s = out;
  }
  return s;
}
