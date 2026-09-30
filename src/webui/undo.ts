// Delete now, offer 撤销 in the toast: the delete's audit txn is reverted
// (core revertChangeGroup resurrects tombstoned rows intact).
import { api, NAV_INVALIDATE, REC_INVALIDATE } from "./api.ts";
import { toast } from "./ui.tsx";
import { t } from "./i18n/t.ts";

export async function undoableDelete(o: {
  label: string;
  ids: string[];
  run: () => Promise<unknown>;
  after?: () => void;
  onRestored?: () => void;
}): Promise<void> {
  await o.run();
  o.after?.();
  let txns: string[] = [];
  try {
    const page = await api.auditList({ limit: o.ids.length + 4 });
    txns = page.entries
      .filter((e) => e.txn && e.entities.some((en) => en.deleted && o.ids.includes(en.id)))
      .map((e) => e.txn!);
  } catch {
    txns = [];
  }
  if (!txns.length) {
    toast(o.label);
    return;
  }
  toast(o.label, {
    ms: 8000,
    action: {
      label: t("撤销##undo"),
      run: async () => {
        try {
          for (const txn of txns) await api.auditRevert(txn);
          document.dispatchEvent(new CustomEvent(NAV_INVALIDATE));
          document.dispatchEvent(new CustomEvent(REC_INVALIDATE));
          toast(t("已恢复"));
          o.onRestored?.();
        } catch (e) {
          toast((e as Error).message, { tone: "error" });
        }
      },
    },
  });
}
