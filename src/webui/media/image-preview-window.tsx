/** @jsxImportSource preact */
// The frameless desktop image-preview window (loaded at `…/#preview?…`). Renders
// the shared ImageViewer full-window. It shares the main window's origin (so the
// auth token + blob bytes are available): annotation save flattens + uploads here,
// then reports the new /blob URL back to the editor window over a same-origin
// BroadcastChannel. Close = window.close().
import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { toast } from "../ui.tsx";
import { ImageViewer } from "./image-lightbox.tsx";

function parseHash(): { src: string; name?: string; blockId: string } {
  const h = typeof location !== "undefined" ? location.hash : "";
  const q = h.includes("?") ? h.slice(h.indexOf("?") + 1) : "";
  const p = new URLSearchParams(q);
  return { src: p.get("src") || "", name: p.get("name") || undefined, blockId: p.get("bid") || "" };
}

export function ImagePreviewWindow() {
  const init = parseHash();
  const [src, setSrc] = useState(init.src);

  const onReplace = async (blob: Blob) => {
    try {
      const up = await api.uploadDocBlob(new File([blob], "annotated.png", { type: "image/png" }));
      try {
        const ch = new BroadcastChannel("mh-doc-image");
        ch.postMessage({ action: "replace", blockId: init.blockId, url: up.url });
        ch.close();
      } catch {
        /* no BroadcastChannel — editor won't auto-update, but the blob is saved */
      }
      setSrc(up.url); // show the flattened result here too
    } catch (err) {
      toast(`保存失败：${(err as Error).message}`);
    }
  };

  return (
    <div class="lightbox preview-win">
      <ImageViewer src={src} name={init.name} draggableBar onClose={() => window.close()} onReplace={onReplace} />
    </div>
  );
}
