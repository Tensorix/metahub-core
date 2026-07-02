// The derived block model as a CM6 StateField.
//
// `docModelField` holds the current `DocModel` (the offset-bearing scan of the
// document — see blockmodel.ts) and updates it on every document change via
// `patchScan`, which re-parses only the damaged line window and splices it into
// the previous model — keystroke cost is proportional to the edit, not the doc.
// Every decoration layer, void widget, and structure key reads it via
// `docModel(state)` so they all see one consistent, offset-accurate view of the
// text. Selection-only transactions do NOT rescan (positions are unchanged); the
// reveal/cursor-aware decoration layers recompute themselves against the same
// cached model.

import { StateField, type EditorState, type Transaction } from "@codemirror/state";
import { scanDoc, patchScan, type DocModel, type Edit } from "./blockmodel";

function rescan(value: DocModel, tr: Transaction): DocModel {
  const edits: Edit[] = [];
  tr.changes.iterChanges((fromA, toA, fromB, toB) => edits.push({ fromA, toA, fromB, toB }));
  const doc = tr.newDoc;
  return patchScan(value, edits, {
    lineCount: doc.lines,
    length: doc.length,
    line: (n) => doc.line(n),
  });
}

export const docModelField = StateField.define<DocModel>({
  create: (state) => scanDoc(state.doc.toString()),
  update: (value, tr) => (tr.docChanged ? rescan(value, tr) : value),
});

/** The current derived block model for a state. */
export function docModel(state: EditorState): DocModel {
  return state.field(docModelField);
}
