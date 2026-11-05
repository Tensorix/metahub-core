/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n/t.ts";
import { call } from "../data/replica.ts";
import { confirmDialog } from "../ui.tsx";
import { SetSection } from "./primitives.tsx";
import type { RecoveryItem } from "../../core/sync/recovery-v2.ts";

function displayField(raw: string, field: "title" | "body", fallback: string): string {
  try {
    const value = JSON.parse(raw)?.[field];
    return typeof value === "string" ? value : fallback;
  } catch { return fallback; }
}

async function desktopItems(id?: string, action?: "copy" | "discard") {
  const response = await fetch(
    "/api/local-recovery/items",
    id
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, action }),
        }
      : {},
  );
  if (!response.ok) throw new Error(`读取恢复事项失败 (${response.status})`);
  return response.json();
}

export function LocalRecovery({ desktop }: { desktop: boolean }) {
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setItems(
      desktop
        ? await desktopItems()
        : await call<RecoveryItem[]>("recoveryItems"),
    );
  }
  useEffect(() => {
    void refresh().catch((error) => setMessage(String(error)));
  }, [desktop]);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function resolve(id: string, action: "copy" | "discard") {
    if (
      action === "discard" &&
      !(await confirmDialog({
        title: t("丢弃此项编辑？"),
        message: t("此项将从待恢复列表移除。"),
        confirmLabel: t("丢弃"),
        danger: true,
      }))
    )
      return;
    await perform(async () => {
      if (desktop) await desktopItems(id, action);
      else await call("resolveRecoveryItem", id, action);
    });
  }
  if (!items.length && !message) return null;
  return (
    <SetSection label={t("本地副本与恢复")}>
      {message && <p role="status">{message}</p>}
      {items.map((item) => (
        <details key={item.id}>
          <summary>{displayField(item.local,"title",item.target)}</summary>
          <p>{t("待恢复内容")}</p>
          <pre>{displayField(item.local,"body",item.local)}</pre>
          {item.remote && (
            <>
              <p>{t("另一份内容")}</p>
              <pre>{displayField(item.remote,"body",item.remote)}</pre>
            </>
          )}
          <button
            class="btn"
            disabled={busy}
            onClick={() => void resolve(item.id, "copy")}
          >
            {t("创建恢复副本")}
          </button>
          <button
            class="btn"
            disabled={busy}
            onClick={() => void resolve(item.id, "discard")}
          >
            {t("丢弃此项")}
          </button>
        </details>
      ))}
    </SetSection>
  );
}
