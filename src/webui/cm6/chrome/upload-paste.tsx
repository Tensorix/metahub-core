// Upload-on-paste/drop + rich-paste for the single-document editor.
//
// A paste/drop carrying files uploads each via the content-addressed pipeline
// (api.uploadDocBlob — only the hash syncs) and inserts the block-level Markdown on
// its own line so the scanner promotes it to a void embed. While a file is in
// flight it shows as a widget decoration (uploadField) — NOT document text — so
// the autosave/sync chain never sees a placeholder; detailed progress lives in
// the global upload tray (ui.tsx startUpload/updateUpload/finishUpload, with
// retry on failure). A paste carrying HTML (and no files) is converted to
// Markdown. `uploadFilesAt` / `pickAndUpload` are exported so the slash menu
// reuses the exact same pipeline via a file picker.

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { api, MAX_UPLOAD_BYTES } from "../../api.ts";
import { blockToText, mediaKindFromMime, type Block } from "../../blocks.ts";
import { htmlToMarkdown } from "../../html-md.ts";
import { startUpload, updateUpload, finishUpload, toast } from "../../ui.tsx";
import { addUpload, removeUpload, uploadField, beginUpload, endUpload, embedAnchor } from "./upload-field";

export interface UploadDeps {
  onError?: (message: string) => void;
}

let seq = 0;
function newToken(): string {
  return `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function mediaFilesFrom(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items) for (let i = 0; i < dt.items.length; i++) {
    const it = dt.items[i];
    if (it && it.kind === "file") { const f = it.getAsFile(); if (f) out.push(f); }
  }
  if (!out.length && dt.files) for (let i = 0; i < dt.files.length; i++) out.push(dt.files[i]!);
  return out;
}

function safeName(name: string): string {
  return (name || "文件").replace(/[\r\n]+/g, " ").trim() || "文件";
}

function tryDispatch(view: EditorView, spec: Parameters<EditorView["dispatch"]>[0]): void {
  try { view.dispatch(spec); } catch { /* view gone */ }
}

/** The pending entry for `token`, at its CURRENT (remapped) position — null once
 *  removed or when the view/state is gone (doc switched away mid-upload). */
function pendingFor(view: EditorView, token: string): { pos: number } | null {
  try {
    return view.state.field(uploadField, false)?.find((u) => u.token === token) ?? null;
  } catch {
    return null;
  }
}

function withinCap(file: File, onError?: (m: string) => void): boolean {
  const cap = MAX_UPLOAD_BYTES[mediaKindFromMime(file.type)];
  if (file.size > cap) {
    const msg = `${file.name || "文件"} 超过 ${Math.round(cap / 1024 / 1024)}MB 上限`;
    toast(msg);
    onError?.(msg);
    return false;
  }
  return true;
}

/** Show one uploading widget per file at `pos` (a decoration — the document is
 *  untouched until the upload finishes), upload each concurrently with tray
 *  progress, and insert the embed Markdown at the widget's remapped position on
 *  success. Failure removes the widget and lingers in the tray with a retry that
 *  re-appends at the end of the doc. */
export function uploadFilesAt(view: EditorView, pos: number, files: File[], onError?: (m: string) => void): void {
  files = files.filter((f) => withinCap(f, onError));
  if (!files.length) return;

  // A drop can land in a void's source range — including exactly v.from (the
  // widget's top edge). embedAnchor nudges past the void and anchors at line
  // end so the block widget renders after it (side: 1).
  pos = embedAnchor(view.state, pos);

  const tokens = files.map(() => newToken());
  tryDispatch(view, {
    effects: files.map((f, i) => addUpload.of({ token: tokens[i]!, name: safeName(f.name), pos })),
  });

  files.forEach((file, i) => {
    const token = tokens[i]!;
    const tid = startUpload(file.name || "文件");
    beginUpload();
    api.uploadDocBlob(file, (loaded, total) => updateUpload(tid, loaded, total))
      .then((up) => {
        finishUpload(tid, true);
        const entry = pendingFor(view, token);
        if (!entry) return; // widget gone (doc closed / view rebuilt) — bytes are saved, nothing to insert
        const kind = mediaKindFromMime(file.type);
        const block: Block = { id: `up-${token}`, type: kind, content: "", src: up.url, name: file.name || undefined, size: kind === "file" ? up.size : undefined };
        // The anchor was remapped through every edit during the upload — a void
        // can have FORMED around it in the meantime (user typed a fence/table
        // there). Re-anchor past it before inserting.
        // Replace an empty anchor line, or start a fresh line after a non-empty one.
        const line = view.state.doc.lineAt(embedAnchor(view.state, entry.pos));
        const change = line.text.trim() === ""
          ? { from: line.from, to: line.to, insert: blockToText(block) }
          : { from: line.to, to: line.to, insert: "\n" + blockToText(block) };
        tryDispatch(view, { changes: change, effects: removeUpload.of(token) });
      })
      .catch((err: unknown) => {
        tryDispatch(view, { effects: removeUpload.of(token) });
        finishUpload(tid, false, () => {
          try { uploadFilesAt(view, view.state.doc.length, [file], onError); } catch { /* view gone */ }
        });
        onError?.(`上传失败：${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => endUpload());
  });
}

/** Open a native file picker (filtered by accept) and upload the chosen files. */
export function pickAndUpload(view: EditorView, pos: number, accept: string, onError?: (m: string) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = true;
  input.style.display = "none";
  input.addEventListener("change", () => {
    const files = input.files ? Array.from(input.files) : [];
    if (files.length) uploadFilesAt(view, pos, files, onError);
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}

export function uploadPaste(deps: UploadDeps = {}): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = mediaFilesFrom(event.clipboardData);
      if (files.length) {
        event.preventDefault();
        uploadFilesAt(view, view.state.selection.main.head, files, deps.onError);
        return true;
      }
      // No files: convert pasted HTML to Markdown (plain text falls through to
      // CM). Our OWN copy flavor (copy-rich.ts tags it data-mh-md) skips the
      // conversion — the plain flavor is the original Markdown, lossless.
      const html = event.clipboardData?.getData("text/html");
      if (html) {
        if (html.includes("data-mh-md")) {
          const md = event.clipboardData?.getData("text/plain") ?? "";
          if (md) {
            event.preventDefault();
            view.dispatch(view.state.replaceSelection(md.replace(/\r\n?/g, "\n")));
            return true;
          }
        }
        event.preventDefault();
        view.dispatch(view.state.replaceSelection(htmlToMarkdown(html).replace(/\r\n?/g, "\n")));
        return true;
      }
      return false;
    },
    drop(event, view) {
      const files = mediaFilesFrom(event.dataTransfer);
      if (!files.length) return false;
      event.preventDefault();
      const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      uploadFilesAt(view, at, files, deps.onError);
      view.focus();
      return true;
    },
  });
}
