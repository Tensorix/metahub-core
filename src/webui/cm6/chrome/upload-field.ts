// Pending-upload state for the single-document editor.
//
// While a file uploads, the editor shows a block widget DECORATION at the
// insertion point — never document text. The old pipeline inserted a literal
// `⏳ 正在上传 … <!--mh-up:token-->` line into the doc, which the 700ms autosave
// then persisted and synced to other devices. A widget can't leak: it lives only
// in this field, positions remap through concurrent edits, and the entry is
// dropped in the same transaction that inserts the finished embed Markdown.
//
// Block widgets from a StateField are fine (same rule as voidField — CM6 only
// forbids block decorations from a ViewPlugin). This module must stay free of
// ui.tsx / Preact imports so it can be exercised headlessly in tests.

import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, type EditorState } from "@codemirror/state";

export interface PendingUpload {
  /** Opaque per-file id minted by upload-paste; keys removal + widget identity. */
  token: string;
  name: string;
  /** Insertion anchor in the CURRENT doc (remapped through every change). */
  pos: number;
}

export const addUpload = StateEffect.define<{ token: string; name: string; pos: number }>();
export const removeUpload = StateEffect.define<string /* token */>();

class UploadingWidget extends WidgetType {
  constructor(readonly token: string, readonly name: string) {
    super();
  }
  override eq(other: UploadingWidget): boolean {
    return other.token === this.token && other.name === this.name;
  }
  override toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-upload-ph";
    div.style.opacity = "0.6";
    div.textContent = `⏳ 正在上传 ${this.name}…`;
    return div;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

function decorate(uploads: readonly PendingUpload[]): DecorationSet {
  return Decoration.set(
    uploads.map((u) =>
      Decoration.widget({ widget: new UploadingWidget(u.token, u.name), block: true, side: 1 }).range(u.pos),
    ),
    true, // entries may be out of doc order — let CM sort
  );
}

export const uploadField = StateField.define<PendingUpload[]>({
  create: () => [],
  update(value, tr) {
    let ups = value;
    // Remap FIRST so an addUpload landing in the same transaction as a doc
    // change (there is none today, but the invariant is cheap) isn't re-mapped.
    if (tr.docChanged) ups = ups.map((u) => ({ ...u, pos: tr.changes.mapPos(u.pos, 1) }));
    for (const e of tr.effects) {
      if (e.is(addUpload)) ups = [...ups, e.value];
      else if (e.is(removeUpload)) ups = ups.filter((u) => u.token !== e.value);
    }
    return ups;
  },
  provide: (f) => EditorView.decorations.from(f, decorate),
});

export function pendingUploads(state: EditorState): PendingUpload[] {
  return state.field(uploadField);
}

/** Remove whole lines carrying the old pipeline's persisted placeholder marker
 *  (`<!--mh-up:token-->`). Docs saved while that bug was live still contain the
 *  junk lines; piping loads/remote merges through this heals them. The marker is
 *  machine-generated, so ANY line containing it is junk by construction. Pure
 *  and idempotent; returns the input unchanged when no marker is present. */
export function stripStaleUploadLines(s: string): string {
  if (!s.includes("mh-up:")) return s;
  const marker = /<!--mh-up:[0-9a-z-]+-->/;
  const lines = s.split("\n");
  const kept = lines.filter((l) => !marker.test(l));
  return kept.length === lines.length ? s : kept.join("\n");
}

// ---- in-flight guard --------------------------------------------------------
// Uploads survive doc switches (the widget dies with the view, the promise does
// not), but a page unload kills them. Track in-flight count so beforeunload can
// warn while anything is still transferring.

let inFlight = 0;

export function beginUpload(): void {
  inFlight++;
}

export function endUpload(): void {
  inFlight = Math.max(0, inFlight - 1);
}

export function uploadsInFlight(): number {
  return inFlight;
}

// Registered once at module load; guarded so headless (test) imports stay clean.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", (e) => {
    if (inFlight > 0) e.preventDefault();
  });
}
