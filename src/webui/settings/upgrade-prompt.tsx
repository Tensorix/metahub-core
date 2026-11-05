/** @jsxImportSource preact */
import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { getReplicaBus } from "../data/replica-bus.ts";
import { onReplicaStatus, replicaStatus } from "../data/replica.ts";
import { withSavedWorkspace } from "../document-lifecycle.ts";
import { t } from "../i18n/t.ts";
import { toast } from "../ui.tsx";

const Warning = createContext<ComponentChildren>(null);
export function UpgradeWarning() {
  return <>{useContext(Warning)}</>;
}

export function UpgradePrompt({ children }: { children: ComponentChildren }) {
  const desktop = window.metahubDesktop;
  const [urls, setUrls] = useState<string[]>([]);
  const [selected, select] = useState("");
  const [dismissed, dismiss] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const [postponed, postpone] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!desktop) {
      const update = (s: ReturnType<typeof replicaStatus>) => setUrls(s.recoveryRequired?.length ? s.recoveryRequired : s.upgradeBuckets ?? []);
      update(replicaStatus());
      return onReplicaStatus(update);
    }
    if (!desktop.rebuildReplica) return;
    const controller = new AbortController();
    const check = async () => {
      try {
        const res = await fetch("/api/local-recovery/upgrade", { signal: controller.signal });
        if (res.ok) setUrls(await res.json());
      } catch { /* Sidecar may be restarting. Retry when the window regains focus. */ }
    };
    void check();
    const timer = window.setInterval(() => { if (!document.hidden) void check(); }, 60_000);
    window.addEventListener("focus", check);
    return () => { clearInterval(timer); controller.abort(); window.removeEventListener("focus", check); };
  }, [desktop]);
  const key = JSON.stringify(urls);
  const visible = busy || (!!urls.length && key !== dismissed);
  const showDialog = visible && !postponed;
  useEffect(() => {
    if (showDialog && !dialog.current?.open) dialog.current?.showModal();
  }, [showDialog]);
  const url = urls.includes(selected) ? selected : urls[0];
  async function upgrade() {
    if (running.current || !url) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await withSavedWorkspace(() => desktop ? desktop.rebuildReplica!(url) : getReplicaBus().rebuild(url));
      dismiss(key);
      if (result.pending) toast(t("本地副本已更新，有 {n} 项编辑待恢复。", { n: result.pending }), {
        action: { label: t("查看"), run: () => { location.hash = "/settings?sec=backup"; } },
      });
      else toast(t("本地副本已更新。"));
      if (desktop) {
        if (result.pending) location.hash = "/settings?sec=backup";
        location.reload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { running.current = false; setBusy(false); }
  }
  const controls = <>
    <div>
      <strong>{t("升级工作区同步")}</strong>
      <p role="status">{busy ? t("正在保存编辑并更新本地副本…") : t("应用会备份本机编辑并更新同步格式。升级期间请保持应用打开，编辑会短暂停用。")}</p>
      {error && <p role="alert">{error}</p>}
    </div>
    {urls.length > 1 && <select aria-label={t("重建使用的存储桶")} disabled={busy} value={url} onChange={e => select(e.currentTarget.value)}>
      {urls.map(u => <option key={u} value={u}>{u}</option>)}
    </select>}
    <button class="btn btn-primary" disabled={busy} onClick={() => void upgrade()}>{t("立即升级")}</button>
  </>;
  const warning = visible && !showDialog && <section class="set-callout warn sync-upgrade" aria-label={t("升级工作区同步")}>{controls}</section>;
  return <Warning.Provider value={warning}>
    {children}
    {showDialog && <dialog ref={dialog} class="sync-upgrade-dialog" aria-label={t("升级工作区同步")} onCancel={e => {
      e.preventDefault();
      if (!running.current) postpone(true);
    }}>
      {controls}
      <button class="btn" disabled={busy} onClick={() => postpone(true)}>{t("稍后")}</button>
    </dialog>}
  </Warning.Provider>;
}
