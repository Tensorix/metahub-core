import { type WorkspaceAccess, requiresWorkspaceConfirmation } from "../../core/sync/workspace-access.ts";
/** @jsxImportSource preact */
import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { getReplicaBus } from "../data/replica-bus.ts";
import { isNoOrigin, replicaEnabled, onReplicaStatus, replicaStatus } from "../data/replica.ts";
import { protectVersionDrafts, withSavedWorkspace } from "../document-lifecycle.ts";
import { t } from "../i18n/t.ts";
import { dataVersionRange } from "../../core/sync/data-version.ts";
import { toast } from "../ui.tsx";

const Warning = createContext<ComponentChildren>(null);
export function UpgradeWarning() {
  return <>{useContext(Warning)}</>;
}

export function UpgradePrompt({ children }: { children: ComponentChildren }) {
  const [version, setVersion] = useState(2);
  const updateRequired = version > dataVersionRange.maxSupportedDataVersion;
  const desktop = window.metahubDesktop;
  const [urls, setUrls] = useState<string[]>([]);
  const [access, setAccess] = useState<WorkspaceAccess[]>([]);
  const [automaticBusy, setAutomaticBusy] = useState(false);
  const autoAttempts = useRef(new Set<string>());
  const [attempt, retry] = useState(0);
  const [selected, select] = useState("");
  const [dismissed, dismiss] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const [postponed, postpone] = useState("");
  const promptKind = updateRequired ? `client-${version}` : "replica";
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!desktop) {
      const update = (s: ReturnType<typeof replicaStatus>) => {
        if (replicaEnabled() || isNoOrigin()) setVersion(s.dataVersion ?? 2);
        if (s.workspaceAccess) { setAccess(s.workspaceAccess); setUrls(s.workspaceAccess.filter(requiresWorkspaceConfirmation).map(state => state.url)); }
        else setUrls(s.recoveryRequired?.length ? s.recoveryRequired : s.upgradeBuckets ?? []);
      };
      const controller = new AbortController();
      const check = async () => {
        if (replicaEnabled() || isNoOrigin()) return;
        try {
          const res = await fetch("/health", { signal: controller.signal, cache: "no-store" });
          if (res.ok) setVersion((await res.json()).dataVersion ?? 1);
        } catch { /* Retain the last known version while disconnected. */ }
      };
      update(replicaStatus());
      void check();
      const unsubscribe = onReplicaStatus(update);
      window.addEventListener("focus", check);
      window.addEventListener("online", check);
      return () => { controller.abort(); unsubscribe(); window.removeEventListener("focus", check); window.removeEventListener("online", check); };
    }
    if (!desktop.rebuildReplica) return;
    const controller = new AbortController();
    const check = async () => {
      try {
        let res = await fetch("/api/local-recovery/compatibility", { signal: controller.signal, cache: "no-store" });
        if (res.status === 404) res = await fetch("/api/local-recovery/upgrade", { signal: controller.signal, cache: "no-store" });
        if (res.ok) { const info = await res.json(); setUrls(Array.isArray(info) ? info : info.urls); setVersion(info.dataVersion ?? 2); if (info.workspaceAccess) { setAccess(info.workspaceAccess); setUrls(info.workspaceAccess.filter(requiresWorkspaceConfirmation).map((state: WorkspaceAccess) => state.url)); } }
      } catch { /* Sidecar may be restarting. Retry when the window regains focus. */ }
    };
    void check();
    const timer = window.setInterval(() => { if (!document.hidden) void check(); }, 60_000);
    window.addEventListener("focus", check);
    return () => { clearInterval(timer); controller.abort(); window.removeEventListener("focus", check); };
  }, [desktop, attempt]);
  useEffect(() => {
    const candidates = access.filter(state => state.kind === "initializing");
    if (candidates.length !== 1 || updateRequired || running.current) return;
    const state = candidates[0]!;
    if (!desktop && !getReplicaBus().leader) return;
    if (autoAttempts.current.has(state.url)) return;
    autoAttempts.current.add(state.url);
    running.current = true; setAutomaticBusy(true); setError("");
    void withSavedWorkspace(() => desktop ? desktop.rebuildReplica!(state.url, true) : getReplicaBus().rebuild(state.url, true)).then(() => {
      setAccess(previous => previous.filter(item => item.url !== state.url));
      if (desktop) location.reload();
    }).catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => { running.current = false; setAutomaticBusy(false); });
  }, [access, desktop, updateRequired, attempt]);
  useEffect(() => {
    if (updateRequired) void protectVersionDrafts().catch(e => setError(String(e)));
  }, [updateRequired]);
  const key = JSON.stringify(urls);
  const visible = !automaticBusy && (updateRequired || busy || (!!urls.length && key !== dismissed));
  const showDialog = visible && postponed !== promptKind;
  useEffect(() => {
    if (showDialog && !dialog.current?.open) dialog.current?.showModal();
  }, [showDialog]);
  const url = urls.includes(selected) ? selected : urls[0];
  const rebuilding = access.find(state => state.url === url)?.kind === "rebuild";
  const actionTitle = rebuilding ? t("更新本地副本") : t("升级工作区同步");
  async function retryConnection() {
    autoAttempts.current.clear(); setError(""); retry(n => n + 1);
    if (!desktop) await getReplicaBus().call("sync").catch(failure => setError(String(failure)));
  }
  async function upgrade() {
    if (updateRequired || running.current || !url) return;
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
  async function updateApp() {
    try { await protectVersionDrafts(); } catch (e) { setError(String(e)); return; }
    postpone(promptKind);
    if (desktop) { location.hash = "/settings?sec=about"; return; }
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration) await registration.update();
      setError(t("更新安装完成后，请重新打开应用。"));
    } catch (e) { setError(String(e)); }
  }
  const controls = updateRequired ? <>
    <div><strong>{t("需要更新客户端")}</strong>
      <p>{t("工作区数据版本为 {remote}，当前客户端最高支持 {max}。本地内容可查看和导出。", { remote: version, max: dataVersionRange.maxSupportedDataVersion })}</p>
      {error && <p role="status">{error}</p>}
    </div><button class="btn btn-primary" onClick={() => void updateApp()}>{t("更新应用")}</button>
  </> : <>
    <div>
      <strong>{actionTitle}</strong>
      <p role="status">{busy ? t("正在保存编辑并更新本地副本…") : t("应用会备份本机编辑并更新同步格式。升级期间请保持应用打开，编辑会短暂停用。")}</p>
      {error && <p role="alert">{error}</p>}
    </div>
    {urls.length > 1 && <select aria-label={t("重建使用的存储桶")} disabled={busy} value={url} onChange={e => select(e.currentTarget.value)}>
      {urls.map(u => <option key={u} value={u}>{u}</option>)}
    </select>}
    <button class="btn btn-primary" disabled={busy} onClick={() => void upgrade()}>{rebuilding ? t("立即更新") : t("立即升级")}</button>
  </>;
  const connectionError = error || access.find(state => state.kind === "error")?.reason;
  const initializing = automaticBusy || access.some(state => state.kind === "initializing");
  const progress = !updateRequired && !urls.length && (initializing || connectionError) && <section class="set-callout" role="status">
    <span>{connectionError || t("正在连接工作区并校验本地数据…")}</span>
    {!automaticBusy && connectionError && <button class="btn" onClick={() => void retryConnection()}>{t("重试")}</button>}
  </section>;
  const warning = visible && !showDialog && <section class="set-callout warn sync-upgrade" aria-label={updateRequired ? t("需要更新客户端") : actionTitle}>{controls}</section>;
  return <Warning.Provider value={warning || progress}>
    {children}
    {initializing && !connectionError && <div class="sync-upgrade-progress" role="status">{t("正在连接工作区并校验本地数据…")}</div>}
    {showDialog && <dialog ref={dialog} class="sync-upgrade-dialog" aria-label={updateRequired ? t("需要更新客户端") : actionTitle} onCancel={e => {
      e.preventDefault();
      if (!running.current) postpone(promptKind);
    }}>
      {controls}
      <button class="btn" disabled={busy} onClick={() => postpone(promptKind)}>{updateRequired ? t("只读查看") : t("稍后")}</button>
    </dialog>}
  </Warning.Provider>;
}
