/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n/t.ts";
import { call } from "../data/replica.ts";
import { getReplicaBus } from "../data/replica-bus.ts";
import { withSavedWorkspace } from "../document-lifecycle.ts";
import { confirmDialog } from "../ui.tsx";
import { SetSection } from "./primitives.tsx";
import type { RecoveryItem } from "../../core/sync/recovery-v2.ts";

type Bucket = {
  url: string;
  bucket?: string | null;
  enabled: number | boolean;
};

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

export function LocalRecovery({
  buckets,
  desktop,
}: {
  buckets: Bucket[];
  desktop: boolean;
}) {
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const [selected, select] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const enabled = buckets.filter((bucket) => bucket.enabled);
  const shellUpdate = desktop && !window.metahubDesktop?.rebuildReplica;
  const url = enabled.some((bucket) => bucket.url === selected)
    ? selected
    : enabled[0]?.url;
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
  async function rebuild() {
    if (
      !url ||
      !(await confirmDialog({
        title: t("重建本地副本"),
        message: t(
          "先保存编辑并备份数据库和附件，再从所选存储桶下载当前副本。",
        ),
        confirmLabel: t("开始重建"),
      }))
    )
      return;
    await perform(async () => {
      setMessage(t("正在保存编辑并更新本地副本…"));
      const result = await withSavedWorkspace(() => desktop
        ? window.metahubDesktop!.rebuildReplica!(url)
        : getReplicaBus().rebuild(url));
      setMessage(
        result.pending
          ? t("本地副本已更新，有 {n} 项编辑待恢复。", { n: result.pending })
          : t("本地副本已更新。"),
      );
    });
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
  return (
    <SetSection label={t("本地副本与恢复")}>
      {enabled.length > 1 && (
        <select
          aria-label={t("重建使用的存储桶")}
          value={url}
          disabled={busy}
          onChange={(e) => select(e.currentTarget.value)}
        >
          {enabled.map((bucket) => (
            <option value={bucket.url}>{bucket.bucket ?? bucket.url}</option>
          ))}
        </select>
      )}
      {shellUpdate && <p>{t("升级桌面应用后即可重建本地副本。")}</p>}
      <button
        class="btn"
        disabled={busy || !url || shellUpdate}
        onClick={() => void rebuild()}
      >
        {t("保全编辑并重建本地副本")}
      </button>
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
