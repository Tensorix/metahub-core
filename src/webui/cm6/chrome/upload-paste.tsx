// Upload-on-paste/drop + rich-paste for the single-document editor.
//
// A paste/drop carrying files uploads each via the content-addressed pipeline
// (api.uploadDocBlob — only the hash syncs) and inserts the block-level Markdown on
// its own line so the scanner promotes it to a void embed. A paste carrying HTML
// (and no files) is converted to Markdown. `uploadFilesAt` / `pickAndUpload` are
// exported so the slash menu reuses the exact same pipeline via a file picker.

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { api, MAX_UPLOAD_BYTES } from "../../api.ts";
import { blockToText, mediaKindFromMime, type Block } from "../../blocks.ts";
import { htmlToMarkdown } from "../../html-md.ts";
import { docModel } from "../doc-model";

export interface UploadDeps {
  onError?: (message: string) => void;
}

let seq = 0;
function newToken(): string {
  return `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function mediaFilesFrom(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items) for (let i = 0; i < dt.items.length; i++) {
    const it = dt.items[i];
    if (it && it.kind === "file") { const f = it.getAsFile(); if (f) out.push(f); }
  }
  if (!out.length && dt.files) for (let i = 0; i < dt.files.length; i++) out.push(dt.files[i]!);
  return out;
}

function placeholderLine(name: string, token: string): string {
  const safe = (name || "文件").replace(/[\r\n]+/g, " ").trim() || "文件";
  return `⏳ 正在上传 ${safe}… <!--mh-up:${token}-->`;
}

function tryDispatch(view: EditorView, spec: Parameters<EditorView["dispatch"]>[0]): void {
  try { view.dispatch(spec); } catch { /* view gone */ }
}

function locate(view: EditorView, token: string): { from: number; to: number } | null {
  const idx = view.state.doc.toString().indexOf(`mh-up:${token}`);
  if (idx < 0) return null;
  const line = view.state.doc.lineAt(idx);
  return { from: line.from, to: line.to };
}

function withinCap(file: File, onError?: (m: string) => void): boolean {
  const cap = MAX_UPLOAD_BYTES[mediaKindFromMime(file.type)];
  if (file.size > cap) {
    onError?.(`${file.name || "文件"} 超过 ${Math.round(cap / 1024 / 1024)}MB 上限`);
    return false;
  }
  return true;
}

/** Insert one placeholder line per file at `pos`, upload each concurrently, and
 *  write the resulting embed Markdown over its placeholder. */
export function uploadFilesAt(view: EditorView, pos: number, files: File[], onError?: (m: string) => void): void {
  files = files.filter((f) => withinCap(f, onError));
  if (!files.length) return;

  // A drop can land inside a void's raw source; nudge past it.
  const enclosing = docModel(view.state).voids.find((v) => pos > v.from && pos < v.to);
  if (enclosing) pos = enclosing.to;

  const tokens = files.map(() => newToken());
  const body = files.map((f, i) => placeholderLine(f.name, tokens[i]!)).join("\n");
  const line = view.state.doc.lineAt(pos);
  const before = view.state.sliceDoc(line.from, pos);
  const after = view.state.sliceDoc(pos, line.to);

  let from: number, to: number, insert: string;
  if (before.trim() === "" && after.trim() === "") {
    from = line.from; to = line.to; insert = body;
  } else {
    from = pos; to = pos; insert = (before.length ? "\n" : "") + body + (after.length ? "\n" : "");
  }
  tryDispatch(view, { changes: { from, to, insert }, selection: { anchor: from + insert.length } });

  files.forEach((file, i) => {
    const token = tokens[i]!;
    api.uploadDocBlob(file)
      .then((up) => {
        const kind = mediaKindFromMime(file.type);
        const block: Block = { id: `up-${token}`, type: kind, content: "", src: up.url, name: file.name || undefined, size: kind === "file" ? up.size : undefined };
        const l = locate(view, token);
        if (l) tryDispatch(view, { changes: { from: l.from, to: l.to, insert: blockToText(block) } });
      })
      .catch((err: unknown) => {
        const l = locate(view, token);
        if (l) {
          const docLen = view.state.doc.length;
          let f = l.from, t = l.to;
          if (t < docLen) t += 1; else if (f > 0) f -= 1;
          tryDispatch(view, { changes: { from: f, to: t, insert: "" } });
        }
        onError?.(`上传失败：${err instanceof Error ? err.message : String(err)}`);
      });
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
      // No files: convert pasted HTML to Markdown (plain text falls through to CM).
      const html = event.clipboardData?.getData("text/html");
      if (html) {
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
