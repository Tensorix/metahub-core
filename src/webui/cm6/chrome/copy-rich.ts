// Rich-flavor clipboard for copy/cut.
//
// CM6's built-in copy writes the raw selected doc text as text/plain only — in
// this editor the doc IS Markdown source, so pasting into Word/mail/WeChat
// produced literal `**粗体**` / `[文字](url)`. The old contentEditable editor
// carried a text/html flavor for free; restore it by rendering the selected
// Markdown through the SHARED share renderer (core/sync/share-render — the
// same HTML the share page shows, so the flavors can't drift).
//
// text/plain stays the RAW MARKDOWN: internal copy → paste must round-trip
// losslessly. The html flavor is tagged with data-mh-md so our own paste
// handler (upload-paste.tsx) recognizes it and prefers the plain flavor
// instead of running htmlToMarkdown over our rendered output.

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { renderMarkdown } from "../../../core/sync/share-render";

/** Marker attribute identifying clipboard HTML produced by this editor. */
export const MH_CLIP_ATTR = "data-mh-md";

function selectedMarkdown(view: EditorView): string {
  const parts = view.state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => view.state.sliceDoc(r.from, r.to));
  return parts.join("\n");
}

function writeClipboard(event: ClipboardEvent, md: string): void {
  event.clipboardData?.setData("text/plain", md);
  event.clipboardData?.setData("text/html", `<div ${MH_CLIP_ATTR}="1">${renderMarkdown(md)}</div>`);
  event.preventDefault();
}

export function copyRich(): Extension {
  return EditorView.domEventHandlers({
    copy(event, view) {
      const md = selectedMarkdown(view);
      if (!md) return false;
      writeClipboard(event, md);
      return true;
    },
    cut(event, view) {
      const md = selectedMarkdown(view);
      if (!md || view.state.readOnly) return false;
      writeClipboard(event, md);
      view.dispatch(view.state.replaceSelection(""), { userEvent: "delete.cut", scrollIntoView: true });
      return true;
    },
  });
}
