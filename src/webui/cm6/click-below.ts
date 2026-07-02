// Click-below-the-body: clicking the empty area under the editor (the page
// column's bottom padding — document-flow scrolling means the editor is exactly
// as tall as its content) drops the caret on a trailing empty paragraph, Notion
// style. The transaction logic is a pure function over EditorState so it can be
// unit-tested headlessly; the thin DOM handler is attached by the host (the
// `.doc` column in editor.tsx), NOT document, so sidebar/topbar clicks are
// never intercepted.

import type { EditorState, TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** The transaction that puts the caret on a trailing empty paragraph:
 *  - last line already empty (length 0) → just move the selection to doc end;
 *  - otherwise → append "\n" at the end and put the caret on the new line.
 *  A doc ending in a void block (image/table/code fence rendered as a block
 *  widget) still has a non-empty last markdown line, so it takes the append
 *  path — no special casing needed. */
export function caretToTrailingEmptyLine(state: EditorState): TransactionSpec {
  const doc = state.doc;
  if (doc.line(doc.lines).length === 0) {
    return { selection: { anchor: doc.length }, scrollIntoView: true };
  }
  return {
    changes: { from: doc.length, insert: "\n" },
    selection: { anchor: doc.length + 1 },
    userEvent: "input",
    scrollIntoView: true,
  };
}

/** mousedown handler for the body column container. Acts only when the press
 *  is (a) primary button, (b) on the bare container itself (target ===
 *  currentTarget — children like the conflict banner, lightbox, or the editor
 *  DOM are never hijacked), and (c) below the editor's bottom edge. Prevents
 *  default so the press doesn't move focus to the container, then dispatches
 *  and focuses the view. Returns whether it handled the event. */
export function handleClickBelow(view: EditorView, event: MouseEvent): boolean {
  if (event.button !== 0) return false;
  if (event.target !== event.currentTarget) return false;
  if (event.clientY <= view.dom.getBoundingClientRect().bottom) return false;
  event.preventDefault();
  view.dispatch(caretToTrailingEmptyLine(view.state));
  view.focus();
  return true;
}
