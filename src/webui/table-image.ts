import { downloadBlob } from "./download-blob.ts";
import { t } from "./i18n/t.ts";
import { renderTableImage, type TableImageData } from "./table-image-render.ts";
import { toast } from "./ui.tsx";

export { assertTableImageSize, type TableImageData, type TableImageCell } from "./table-image-render.ts";

type ImageWriter = (png: Blob) => Promise<void>;
let nativeWriter: ImageWriter | undefined;

export function setTableImageClipboardWriter(writer: ImageWriter | undefined) {
  nativeWriter = writer;
}

export async function copyTableImage(source: () => TableImageData | Promise<TableImageData>): Promise<void> {
  const writer = nativeWriter;
  let progress: ReturnType<typeof toast> | undefined;
  const timer = setTimeout(() => {
    if (writer === nativeWriter) progress = toast(t("正在生成表格图片"), { tone: "info", ms: 60_000 });
  }, 500);
  try {
    const png = Promise.resolve(source()).then(renderTableImage);
    if (writer) await writer(await png);
    else {
      // WebKit checks user activation at write(), before async query reads,
      // layout or PNG encoding complete. Pass the promise as the item flavor.
      let copied = false;
      if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function") {
        // A browser can reject permission before it consumes the item.
        void png.catch(() => {});
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
          copied = true;
        } catch { /* Offer the same PNG as a download when writes are blocked. */ }
      }
      if (!copied) {
        const blob = await png;
        toast(t("无法写入剪贴板，可下载图片"), {
          tone: "info", action: { label: t("下载 PNG"), run: () => downloadBlob("table.png", blob) },
        });
        return;
      }
    }
    if (writer === nativeWriter) toast(t("已复制图片"));
  } catch (error) {
    if (writer === nativeWriter) toast(error instanceof Error ? error.message : t("无法生成表格图片，请重试"), { tone: "error" });
  } finally {
    clearTimeout(timer);
    progress?.dismiss();
  }
}
