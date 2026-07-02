// Atomic ranges for CONSTANT list markers (bullet glyph, todo checkbox).
//
// Their hidden indent+marker text `[line.from, contentFrom)` is replaced by a
// permanent widget, so a caret inside it would be invisible — and Backspace
// there used to silently eat hidden characters. Atomicity makes the caret skip
// the whole span (ArrowLeft: contentFrom → line.from → previous line end) and
// makes default forward/word deletes treat the marker as one unit.
//
// NUMBERED markers are deliberately NOT atomic: the ordinal is ordinary,
// user-editable text (literal numbers are authoritative — the editor never
// renumbers existing items), so the caret must be able to walk into the digits.
// Heading/quote markers stay non-atomic too (caret-driven reveal-to-edit).

import { EditorState, RangeSetBuilder, RangeValue, StateField, type RangeSet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { docModel } from "./doc-model";

class AtomMark extends RangeValue {}
const ATOM = new AtomMark();

function buildAtoms(state: EditorState): RangeSet<AtomMark> {
  const b = new RangeSetBuilder<AtomMark>();
  for (const li of docModel(state).lines) {
    if (li.role !== "bullet" && li.role !== "todo") continue;
    // Cover the hidden indent TOO, not just [markerFrom, contentFrom): a nested
    // item's leading whitespace is an invisible replace as well.
    if (li.contentFrom > li.from) b.add(li.from, li.contentFrom, ATOM);
  }
  return b.finish();
}

/** Whole-document atomic ranges for the constant list markers (voidField
 *  precedent: a StateField, not viewport-scoped plugin state). */
export const markerAtomsField = StateField.define<RangeSet<AtomMark>>({
  create: buildAtoms,
  update: (value, tr) => (tr.docChanged ? buildAtoms(tr.state) : value),
  provide: (f) => EditorView.atomicRanges.of((view) => view.state.field(f)),
});
