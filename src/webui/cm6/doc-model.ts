// The derived block model as a CM6 StateField.
//
// `docModelField` holds the current `DocModel` (the offset-bearing scan of the
// document — see blockmodel.ts) and recomputes it on every document change. Every
// decoration layer, void widget, and structure key reads it via `docModel(state)`
// so they all see one consistent, offset-accurate view of the text. Selection-only
// transactions do NOT rescan (positions are unchanged); the reveal/cursor-aware
// decoration layers recompute themselves against the same cached model.

import { StateField, type EditorState } from "@codemirror/state";
import { scanDoc, type DocModel } from "./blockmodel";

export const docModelField = StateField.define<DocModel>({
  create: (state) => scanDoc(state.doc.toString()),
  update: (value, tr) => (tr.docChanged ? scanDoc(tr.newDoc.toString()) : value),
});

/** The current derived block model for a state. */
export function docModel(state: EditorState): DocModel {
  return state.field(docModelField);
}
