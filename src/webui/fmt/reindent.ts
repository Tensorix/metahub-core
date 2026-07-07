// Language-agnostic bracket-depth reindent: the 格式化 fallback for brace
// languages without a real browser engine (rust/swift/kotlin/perl — see
// lang-map.ts). Rewrites ONLY each line's leading whitespace to
// `depth × INDENT`; line content is never touched, so a wrong guess costs
// looks, never semantics. A small cross-line scanner keeps brackets inside
// strings and comments from counting toward depth.
//
// Known accepted imperfections: multi-line plain strings (rust) end scanning
// at EOL, and exotic literals (raw strings, here-docs) aren't modeled — worst
// case some lines get the wrong indent, which the user can undo in one step.

import { INDENT } from "../media/code-edit.ts";

interface Rules {
  /** Line-comment openers (rest of line ignored). */
  line: string[];
  /** Block comment delimiters. */
  block: [open: string, close: string][];
  /** Quote chars. `\`` survives EOL (template literal); `'`/`"` reset at EOL. */
  quotes: string[];
}

const C_RULES: Rules = { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'", "`"] };
const HASH_RULES: Rules = { line: ["#"], block: [], quotes: ['"', "'", "`"] };

const RULES_BY_LANG: Record<string, Rules> = {
  perl: HASH_RULES, pl: HASH_RULES,
};

const OPEN = "{[(";
const CLOSE = ")]}";

interface ScanState {
  /** Open quote char, or null. */
  quote: string | null;
  /** Close token of the block comment we're inside, or null. */
  blockClose: string | null;
}

/** Scan one line, mutating `st` and returning the bracket depth delta. */
function scanLine(line: string, st: ScanState, rules: Rules): number {
  let delta = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (st.quote) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === st.quote) st.quote = null;
      i++;
      continue;
    }
    if (st.blockClose) {
      if (line.startsWith(st.blockClose, i)) { i += st.blockClose.length; st.blockClose = null; continue; }
      i++;
      continue;
    }
    if (rules.quotes.includes(ch)) { st.quote = ch; i++; continue; }
    const block = rules.block.find(([open]) => line.startsWith(open, i));
    if (block) { st.blockClose = block[1]; i += block[0].length; continue; }
    if (rules.line.some((tok) => line.startsWith(tok, i))) break;
    if (OPEN.includes(ch)) delta++;
    else if (CLOSE.includes(ch)) delta--;
    i++;
  }
  // ' and " don't span lines in the C family; ` (template literal) does.
  if (st.quote && st.quote !== "`") st.quote = null;
  return delta;
}

/**
 * Rewrite each line's leading whitespace to match bracket nesting depth.
 * Returns null when the text is already in shape (callers skip the write-back
 * so undo history stays clean). Lines inside multi-line strings or block
 * comments are left untouched — their leading whitespace is content.
 */
export function reindent(code: string, lang?: string): string | null {
  const rules = RULES_BY_LANG[lang?.trim().toLowerCase() ?? ""] ?? C_RULES;
  const st: ScanState = { quote: null, blockClose: null };
  let depth = 0;
  // A line's net depth increase is clamped to one level: `f({` opens two
  // brackets but reads as one indent step (the prettier convention). Closers
  // are NOT clamped — the matching `});` line dedents by its full leading run,
  // and the depth floor at 0 absorbs the asymmetry.
  const bump = (delta: number) => { depth = Math.max(0, depth + Math.min(delta, 1)); };
  const out = code.split("\n").map((line) => {
    if (st.quote || st.blockClose) {
      // Continuation of a template literal / block comment: content, not code.
      bump(scanLine(line, st, rules));
      return line;
    }
    const trimmed = line.replace(/^[ \t]+/, "");
    if (trimmed === "") return "";
    let closers = 0;
    while (closers < trimmed.length && CLOSE.includes(trimmed[closers]!)) closers++;
    const indent = INDENT.repeat(Math.max(0, depth - closers));
    bump(scanLine(trimmed, st, rules));
    return indent + trimmed;
  });
  const text = out.join("\n");
  return text === code ? null : text;
}
