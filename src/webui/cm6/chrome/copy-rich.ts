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
//
// Images: doc markdown references blobs as `/blob/<hash>.<ext>?w=…` — a
// relative URL no external app can resolve. The sync write below rewrites
// those to absolute URLs (best effort: works while this origin is reachable),
// then an async pass upgrades the clipboard in place with a self-contained
// text/html (blobs inlined as data: URLs) plus an image/png flavor when the
// selection is exactly one image, so pure-image targets (chat boxes, image
// editors) accept it. If the async write fails the sync flavors remain.

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { renderMarkdown } from "../../../core/sync/share-render";

/** Marker attribute identifying clipboard HTML produced by this editor. */
export const MH_CLIP_ATTR = "data-mh-md";

/** Per-image / whole-selection caps for inlining blobs as data: URLs; larger
 *  images keep the absolute-URL fallback rather than ballooning the clipboard. */
const INLINE_IMG_CAP = 2 * 1024 * 1024;
const INLINE_TOTAL_CAP = 8 * 1024 * 1024;

function selectedMarkdown(view: EditorView): string {
  const parts = view.state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => view.state.sliceDoc(r.from, r.to));
  return parts.join("\n");
}

function mhHtml(md: string, rewriteBlob?: (url: string) => string): string {
  return `<div ${MH_CLIP_ATTR}="1">${renderMarkdown(md, { rewriteBlob })}</div>`;
}

function absoluteBlobUrl(url: string): string {
  return location.origin + url;
}

/** Distinct `/blob/…` URLs referenced by the selection (query stripped — the
 *  `?w=` width hint is a render-time concern, the route serves raw bytes). */
function blobUrlsIn(md: string): string[] {
  return [...new Set([...md.matchAll(/\/blob\/[0-9a-f]{16,64}[^\s)?]*/g)].map((m) => m[0]))];
}

/** The blob URL when the selection is exactly one image line, else null. */
function singleImageUrl(md: string): string | null {
  const m = /^!\[[^\]]*\]\((\/blob\/[^\s)]+?)(?:\?[^\s)]*)?\)$/.exec(md.trim());
  return m ? m[1]! : null;
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}

/** Raster formats createImageBitmap decodes everywhere; svg needs an <img>
 *  path and isn't worth it for a clipboard nicety. */
const PNGABLE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

async function toPng(b: Blob): Promise<Blob | null> {
  if (b.type === "image/png") return b;
  const bmp = await createImageBitmap(b);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0);
  return await new Promise((res) => canvas.toBlob(res, "image/png"));
}

/** Replace the just-written sync flavors with a self-contained rich payload.
 *  Best effort by design: any failure (fetch, decode, permission, Safari's
 *  stricter gesture window) leaves the sync clipboard untouched. */
async function upgradeClipboard(md: string, urls: string[]): Promise<void> {
  const bytes = new Map<string, Blob>();
  await Promise.all(
    urls.map(async (u) => {
      try {
        const res = await fetch(u);
        if (!res.ok) return;
        const b = await res.blob();
        if (b.size <= INLINE_IMG_CAP) bytes.set(u, b);
      } catch {
        /* keep absolute-URL fallback for this blob */
      }
    }),
  );
  if (!bytes.size) return; // nothing inlinable — sync flavors are already the best we can do
  const dataUrls = new Map<string, string>();
  let used = 0;
  for (const [u, b] of bytes) {
    if (used + b.size > INLINE_TOTAL_CAP) continue;
    used += b.size;
    dataUrls.set(u, await blobToDataUrl(b));
  }
  const rewrite = (url: string): string => dataUrls.get(url.split("?")[0]!) ?? absoluteBlobUrl(url);
  const flavors: Record<string, Blob> = {
    "text/plain": new Blob([md], { type: "text/plain" }),
    "text/html": new Blob([mhHtml(md, rewrite)], { type: "text/html" }),
  };
  const single = singleImageUrl(md);
  if (single && PNGABLE.test(single)) {
    const raw = bytes.get(single);
    if (raw) {
      try {
        const png = await toPng(raw);
        if (png) {
          // A lone image ships as {markdown, binary} WITHOUT text/html: targets
          // that prefer html (Notion, chat boxes) would take the html flavor and
          // then strip its data: URI image, pasting nothing. With no html flavor
          // they fall through to image/png and upload the actual pixels; our own
          // paste still round-trips via text/plain.
          delete flavors["text/html"];
          flavors["image/png"] = png;
        }
      } catch {
        /* undecodable — ship without the binary flavor */
      }
    }
  }
  await navigator.clipboard.write([new ClipboardItem(flavors)]);
}

function writeClipboard(event: ClipboardEvent, md: string): void {
  event.clipboardData?.setData("text/plain", md);
  event.clipboardData?.setData("text/html", mhHtml(md, absoluteBlobUrl));
  event.preventDefault();
  const urls = blobUrlsIn(md);
  if (urls.length && typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function") {
    void upgradeClipboard(md, urls).catch(() => {});
  }
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
