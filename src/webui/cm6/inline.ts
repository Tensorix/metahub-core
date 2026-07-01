// Inline live-preview for the single-document editor.
//
// Renders `**bold**`, `*italic*` / `_italic_`, `` `code` ``, `~~strike~~` and
// `[text](url)` by styling the inner content and COLLAPSING the delimiters — until
// the caret enters the span, when the raw markers reappear so you edit real text
// (the inline analogue of reveal-to-edit). Inline decorations may come from a
// ViewPlugin (only block:true replace may not), so this layer is viewport-scoped
// for performance and guarded against IME composition.
//
// It is deliberately single-level (no nested emphasis): matches are collected per
// visible line and selected greedily left-to-right, so `code` protects its
// interior and overlapping candidates are dropped. Void source lines (fenced
// code/html) are skipped so their literal `**`/backticks stay literal.

import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";
import type { Range, EditorSelection } from "@codemirror/state";
import { docModel } from "./doc-model";

interface Cand {
  start: number; // line-local
  end: number; // line-local (exclusive)
  innerFrom: number; // line-local
  innerTo: number; // line-local
  cls: string;
  rank: number; // lower wins on tie
}

/** Ordered so higher-priority (code) is preferred on a start-tie. */
const PATTERNS: { re: RegExp; cls: string; delim: number; rank: number; link?: boolean }[] = [
  { re: /`([^`\n]+)`/g, cls: "cm-code", delim: 1, rank: 0 },
  { re: /\*\*([^*\n]+?)\*\*/g, cls: "cm-strong", delim: 2, rank: 1 },
  { re: /__([^_\n]+?)__/g, cls: "cm-strong", delim: 2, rank: 1 },
  { re: /~~([^~\n]+?)~~/g, cls: "cm-del", delim: 2, rank: 2 },
  { re: /(?<![*\w])\*([^*\n]+?)\*(?!\*)/g, cls: "cm-em", delim: 1, rank: 3 },
  { re: /(?<![_\w])_([^_\n]+?)_(?!_)/g, cls: "cm-em", delim: 1, rank: 3 },
  { re: /\[([^\]\n]+)\]\(([^)\n]+)\)/g, cls: "cm-link", delim: 0, rank: 4, link: true },
];

function candidatesFor(text: string): Cand[] {
  const cands: Cand[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      let innerFrom: number, innerTo: number;
      if (p.link) {
        innerFrom = start + 1;
        innerTo = start + 1 + m[1]!.length;
      } else {
        innerFrom = start + p.delim;
        innerTo = end - p.delim;
      }
      if (innerTo <= innerFrom) continue;
      cands.push({ start, end, innerFrom, innerTo, cls: p.cls, rank: p.rank });
    }
  }
  cands.sort((a, b) => a.start - b.start || a.rank - b.rank || b.end - a.end);
  return cands;
}

/** Does the selection touch [from, to] (endpoints inclusive)? → reveal delimiters. */
function touches(sel: EditorSelection, from: number, to: number): boolean {
  return sel.ranges.some((r) => r.from <= to && r.to >= from);
}

function build(view: EditorView): DecorationSet {
  const model = docModel(view.state);
  const sel = view.state.selection;
  const out: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      pos = line.to + 1;
      const info = model.lines[line.number - 1];
      if (info && info.role === "void") continue; // literal source — don't tokenize
      const text = line.text;
      if (!text) continue;

      const cands = candidatesFor(text);
      let cursor = 0;
      for (const c of cands) {
        if (c.start < cursor) continue; // overlaps a chosen span
        cursor = c.end;
        const absStart = line.from + c.start;
        const absEnd = line.from + c.end;
        const absInnerFrom = line.from + c.innerFrom;
        const absInnerTo = line.from + c.innerTo;
        out.push(Decoration.mark({ class: c.cls }).range(absInnerFrom, absInnerTo));
        if (!touches(sel, absStart, absEnd)) {
          if (absInnerFrom > absStart) out.push(Decoration.replace({}).range(absStart, absInnerFrom));
          if (absEnd > absInnerTo) out.push(Decoration.replace({}).range(absInnerTo, absEnd));
        }
      }
    }
  }
  return Decoration.set(out, true);
}

export const inlineDecorations = ViewPlugin.fromClass(
  class {
    deco: DecorationSet;
    constructor(view: EditorView) {
      this.deco = build(view);
    }
    update(u: ViewUpdate) {
      if (u.view.composing) return; // never churn decorations mid-IME
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.deco = build(u.view);
    }
  },
  { decorations: (v) => v.deco },
);
