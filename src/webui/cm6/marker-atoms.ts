// Atomic ranges for invisible line prefixes.
//
// Two kinds of leading text render as nothing (or as a permanent widget) yet
// exist in the document, so a caret inside them would be invisible — and
// Backspace there used to silently eat hidden characters:
//
//   • CONSTANT list markers (bullet glyph, todo checkbox): the whole hidden
//     indent+marker span `[line.from, contentFrom)` is replaced by a widget.
//     Atomicity makes the caret skip the span (ArrowLeft: contentFrom →
//     line.from → previous line end) and makes default forward/word deletes
//     treat the marker as one unit.
//   • The hidden indent prefix of ANY other indented non-void line (paragraph,
//     heading, quote, blank, numbered item): the renderer hides the leading
//     whitespace covering the canonical level*2 columns behind the 24px column
//     grid. The atom uses the SAME `hiddenIndentChars` the renderer hides, so
//     the caret-jump span and the invisible text can never drift. A visible
//     odd remainder space (or indent past MAX_NEST) stays non-atomic. For a
//     nested numbered item this covers `[from, markerFrom)` — closing the old
//     gap where a caret could sit invisibly inside the item's indent.
//
// NUMBERED marker DIGITS are deliberately NOT atomic: the ordinal is ordinary,
// user-editable text (literal numbers are authoritative — the editor never
// renumbers existing items), so the caret must be able to walk into the digits.
// Heading/quote markers stay non-atomic too (caret-driven reveal-to-edit).

import { EditorState, RangeSetBuilder, RangeValue, StateField, type RangeSet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { docModel } from "./doc-model";
import { hiddenIndentChars } from "./blockmodel";

class AtomMark extends RangeValue {}
const ATOM = new AtomMark();

function buildAtoms(state: EditorState): RangeSet<AtomMark> {
  const b = new RangeSetBuilder<AtomMark>();
  for (const li of docModel(state).lines) {
    if (li.role === "bullet" || li.role === "todo") {
      // Cover the hidden indent TOO, not just [markerFrom, contentFrom): a nested
      // item's leading whitespace is an invisible replace as well.
      if (li.contentFrom > li.from) b.add(li.from, li.contentFrom, ATOM);
    } else if (li.role !== "void" && li.indentChars > 0) {
      // Every other indented line: only the RENDERER-HIDDEN prefix is atomic.
      const hide = hiddenIndentChars(li);
      if (hide > 0) b.add(li.from, li.from + hide, ATOM);
    }
  }
  return b.finish();
}

/** Whole-document atomic ranges for the constant list markers and hidden indent
 *  prefixes (voidField precedent: a StateField, not viewport-scoped plugin state). */
export const markerAtomsField = StateField.define<RangeSet<AtomMark>>({
  create: buildAtoms,
  update: (value, tr) => (tr.docChanged ? buildAtoms(tr.state) : value),
  provide: (f) => EditorView.atomicRanges.of((view) => view.state.field(f)),
});
