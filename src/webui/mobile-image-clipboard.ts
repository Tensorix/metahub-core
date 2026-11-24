import { MAX_CLIPBOARD_PNG_BYTES } from "../../apps/mobile/src/lib/clipboard-image";
import { blobToDataUrl } from "./cm6/chrome/copy-rich";
import { setTableImageClipboardWriter } from "./table-image";
import { t } from "./i18n/t";

export function bindMobileImageClipboard(write: (base64: string) => Promise<void>) {
  setTableImageClipboardWriter(async (png) => {
    if (png.size > MAX_CLIPBOARD_PNG_BYTES) throw new Error(t("表格过大，请缩小范围后重试"));
    const url = await blobToDataUrl(png);
    await write(url.slice("data:image/png;base64,".length));
  });
}
