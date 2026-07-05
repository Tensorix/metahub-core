// Position anchor for the image preview / annotation round-trip.
//
// CM6 block ids are ephemeral, so the preview protocol routes the annotated
// replacement back by the image's src string — which is AMBIGUOUS when the
// same image is embedded twice. This field remembers WHICH void the user
// opened, as a document position remapped through every edit (same pattern as
// upload-field's pending positions), so the write-back can pick the embed the
// user actually annotated instead of the first src match.

import { StateEffect, StateField, type EditorState } from "@codemirror/state";

export interface PreviewAnchor {
  /** The src token the preview window will route back. */
  token: string;
  /** The opened void's `from` in the CURRENT doc (remapped through changes). */
  pos: number;
}

export const setPreviewAnchor = StateEffect.define<PreviewAnchor>();

export const previewAnchorField = StateField.define<PreviewAnchor | null>({
  create: () => null,
  update(value, tr) {
    if (value && tr.docChanged) value = { ...value, pos: tr.changes.mapPos(value.pos, 1) };
    for (const e of tr.effects) if (e.is(setPreviewAnchor)) value = e.value;
    return value;
  },
});

export function previewAnchor(state: EditorState): PreviewAnchor | null {
  return state.field(previewAnchorField, false) ?? null;
}
