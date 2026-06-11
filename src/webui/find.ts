// Find-in-document helpers (the Ctrl-F / Cmd-F search inside the open doc).
//
// The block editor's .editable hosts are *uncontrolled* contentEditable: their
// innerHTML is only rewritten on structural changes (see editor.tsx). Wrapping
// matches in <mark> would mutate that DOM — clobbering the caret and tripping
// the autosave/CRDT pipeline. So we paint matches with the CSS Custom Highlight
// API instead (Range overlays, zero DOM mutation). Electron ships a recent
// Chromium, so ::highlight() is available; we feature-detect and degrade to
// navigation-only (no paint) when it isn't.

export interface FindOpts {
  caseSensitive: boolean;
  wholeWord: boolean;
}

// Highlight registry names. Two layers: every match (soft) + the active one
// (accent, higher priority so it wins where it overlaps the soft layer).
const ALL = "mh-find-all";
const CUR = "mh-find-current";

const SCOPE_SELECTOR = ".doc-title, .editable, .doc-td, pre.code-hl > code.hljs";

/** Whether the CSS Custom Highlight API is usable in this runtime. */
export function findSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    !!(CSS as unknown as { highlights?: unknown }).highlights &&
    typeof (globalThis as { Highlight?: unknown }).Highlight === "function"
  );
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

// Whole-word boundary that only constrains ASCII word edges. CJK runs have no
// word boundaries, so a CJK needle degrades to a plain substring match (the
// boundary check passes on any side whose needle-edge char isn't an ASCII word
// char), matching how users expect "全词" to behave for Chinese text.
function isWholeWord(text: string, start: number, end: number): boolean {
  const first = text[start] ?? "";
  const last = text[end - 1] ?? "";
  const before = start > 0 ? text[start - 1]! : "";
  const after = end < text.length ? text[end]! : "";
  const leftOk = !isWordChar(first) || !isWordChar(before);
  const rightOk = !isWordChar(last) || !isWordChar(after);
  return leftOk && rightOk;
}

/**
 * All match spans of `term` within `text` as [start, end) offset pairs.
 * Shared by block mode (mapped back onto text nodes) and source mode (mapped
 * onto the textarea selection).
 */
export function findInText(text: string, term: string, opts: FindOpts): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!term) return out;
  const hay = opts.caseSensitive ? text : text.toLowerCase();
  const needle = opts.caseSensitive ? term : term.toLowerCase();
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    const end = i + needle.length;
    if (!opts.wholeWord || isWholeWord(text, i, end)) out.push([i, end]);
    from = end > i ? end : i + 1;
  }
  return out;
}

function locate(nodes: Text[], starts: number[], offset: number): { node: Text; offset: number } | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (offset >= starts[i]!) return { node: nodes[i]!, offset: offset - starts[i]! };
  }
  return null;
}

/**
 * Block-mode matches: walk each search scope (a block's editable, the title, a
 * table cell, or a code mirror) on its own so a match never spans block
 * boundaries, build a per-scope text + node-offset map, and resolve each hit to
 * a Range (which may cross text nodes when inline formatting splits the text).
 */
export function collectMatches(root: HTMLElement, term: string, opts: FindOpts): Range[] {
  const ranges: Range[] = [];
  if (!term) return ranges;
  const scopes = Array.from(root.querySelectorAll<HTMLElement>(SCOPE_SELECTOR));
  for (const scope of scopes) {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) nodes.push(n as Text);
    if (!nodes.length) continue;
    let text = "";
    const starts: number[] = [];
    for (const t of nodes) {
      starts.push(text.length);
      text += t.data;
    }
    for (const [s, e] of findInText(text, term, opts)) {
      const a = locate(nodes, starts, s);
      const b = locate(nodes, starts, e);
      if (!a || !b) continue;
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      ranges.push(range);
    }
  }
  // Document order: scopes already come in DOM order; matches within a scope are
  // collected left-to-right, so the array is naturally ordered for next/prev.
  return ranges;
}

/** Register the highlight layers. `current` (if any) is painted on top. */
export function applyHighlights(all: Range[], current: Range | null): void {
  if (!findSupported()) return;
  const HL = (globalThis as unknown as { Highlight: new (...r: Range[]) => { priority: number } }).Highlight;
  const reg = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
  if (all.length) reg.set(ALL, new HL(...all));
  else reg.delete(ALL);
  if (current) {
    const h = new HL(current);
    h.priority = 1;
    reg.set(CUR, h);
  } else {
    reg.delete(CUR);
  }
}

/** Remove both highlight layers (on close, doc switch, or unmount). */
export function clearHighlights(): void {
  if (!findSupported()) return;
  const reg = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
  reg.delete(ALL);
  reg.delete(CUR);
}
