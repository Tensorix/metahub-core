import { flushDocument } from "./document-lifecycle.ts";
import { toast } from "./ui.tsx";
import { t } from "./i18n/t.ts";

export async function openDocumentWindow(id: string) {
  const bridge = window.metahubDesktop?.documents;
  if (!bridge) return;
  try {
    const result = await flushDocument(id);
    if (!result.ok) throw new Error(result.error);
    await bridge.open(id);
  } catch (error) {
    toast(t("无法打开独立窗口：{msg}", { msg: (error as Error).message }), { tone: "error" });
  }
}
