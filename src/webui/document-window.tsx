/** @jsxImportSource preact */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, NAV_INVALIDATE, type DocSummary, type Db } from "./api.ts";
import { DocView, type DocViewHandle, type DocMode } from "./editor.tsx";
import type { DocumentSaveState } from "./document-save.ts";
import { Icon } from "./icons.tsx";
import { t } from "./i18n/t.ts";
import { UiHost, ErrorBar, MenuItem, MenuSep, openMenu } from "./ui.tsx";
import { tip, pressed } from "./shortcuts.ts";
import { DocHistoryPanel } from "./history.tsx";
import { openShareModal } from "./share-modal.tsx";
import { downloadText, safeFilename } from "./export.ts";
import { docPath } from "./crumb.ts";
import { primeDocTitles } from "./doc-titles.ts";
import { syncResolvedTheme, syncThemeColor } from "./theme.ts";
import { parseHash } from "./view.ts";
import { openDocumentWindow } from "./document-window-actions.ts";
import { ensureLive } from "./live.ts";
import { syncBrandFavicon } from "./brand.tsx";

export function DocumentWindow({ id }: { id: string }) {
  const bridge = window.metahubDesktop!.documents!;
  const handle = useRef<DocViewHandle | null>(null);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [dbs, setDbs] = useState<Db[]>([]);
  const [ready, setReady] = useState(false);
  const hadDocument = useRef(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<DocMode>("blocks");
  const [wide, setWide] = useState(false);
  const [history, setHistory] = useState(false);
  const [saving, setSaving] = useState<DocumentSaveState>("saved");
  const onSaveState = useCallback((state: DocumentSaveState) => {
    setSaving(state);
    if (state === "saved") setError("");
  }, []);
  const register = useCallback((value: DocViewHandle | null) => { handle.current = value; }, []);
  const active = docs.find((doc) => doc.id === id);
  if (active) hadDocument.current = true;
  const title = active?.title || t("无标题");
  const path = docPath(id, docs, dbs);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let sequence = 0;
    const refresh = async () => {
      const current = ++sequence;
      try {
        const [nextDocs, nextDbs] = await Promise.all([api.listDocuments(), api.listDatabases()]);
        if (!alive || current !== sequence) return;
        setDocs(nextDocs); setDbs(nextDbs); setReady(true);
        primeDocTitles(nextDocs, nextDbs);
      } catch (error) { if (alive) setError((error as Error).message); }
    };
    const invalidate = () => { clearTimeout(timer); timer = setTimeout(refresh, 80); };
    void refresh();
    ensureLive();
    document.addEventListener(NAV_INVALIDATE, invalidate);
    const appearance = () => { syncResolvedTheme(); syncThemeColor(); syncBrandFavicon(); };
    appearance();
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", appearance);
    window.addEventListener("storage", appearance);
    return () => {
      alive = false; clearTimeout(timer);
      document.removeEventListener(NAV_INVALIDATE, invalidate);
      media.removeEventListener("change", appearance);
      window.removeEventListener("storage", appearance);
    };
  }, []);
  useEffect(() => { document.title = `${title} — Metahub`; }, [title]);

  // Internal links keep this window pinned to its original document. The same
  // hash route covers CM links, rendered table links, and browser back/forward.
  useEffect(() => {
    const original = `#/doc/${id}`;
    const route = () => {
      const target = parseHash(location.hash);
      window.history.replaceState(null, "", original);
      if (target.kind === "doc" && target.id !== id) void openDocumentWindow(target.id);
      if (target.kind === "db") {
        void window.metahubDesktop?.quicknote?.openMain?.(`#/db/${target.id}`).then(() => {
          const channel = new BroadcastChannel("mh-open-db");
          channel.postMessage({ dbId: target.id }); channel.close();
        });
      }
    };
    window.addEventListener("hashchange", route);
    const keys = (event: KeyboardEvent) => {
      if (pressed(event, "save")) { event.preventDefault(); void handle.current?.flushSave(); }
      if (pressed(event, "toggleSource")) { event.preventDefault(); handle.current?.setMode(handle.current.getMode() === "source" ? "blocks" : "source"); }
    };
    window.addEventListener("keydown", keys);
    return () => { window.removeEventListener("hashchange", route); window.removeEventListener("keydown", keys); };
  }, [id]);

  const showHistory = async () => {
    const result = await handle.current?.flushSave();
    if (result && !result.ok) { setError(result.error); return; }
    setHistory(true);
  };
  const menu = (event: MouseEvent) => openMenu(event, (close) => <>
    <MenuItem icon="externalLink" label={t("在主窗口中打开")} onClick={() => { close(); void bridge.openMain(id).catch((e) => setError(e.message)); }} />
    <MenuSep />
    <MenuItem icon="code" label={mode === "source" ? t("块方式显示") : t("代码方式显示")} checked={mode === "source"} onClick={() => { close(); handle.current?.setMode(mode === "source" ? "blocks" : "source"); }} />
    <MenuItem icon="maximize" label={t("宽屏模式")} checked={wide} onClick={() => { close(); setWide(!wide); }} />
    <MenuItem icon="history" label={t("版本历史")} onClick={() => { close(); void showHistory(); }} />
    <MenuSep />
    <MenuItem icon="download" label={t("导出 Markdown")} onClick={() => {
      close(); downloadText(safeFilename(title, ".md"), handle.current?.snapshotMarkdown() ?? "", "text/markdown;charset=utf-8");
    }} />
  </>);
  const label = saving === "saved" ? t("已保存到本机") : saving === "saving" ? t("保存中…") : saving === "conflict" ? t("需要处理冲突") : saving === "error" ? t("保存失败") : t("有未保存修改");
  return <>
    <div class="document-window main">
      <div class="dw-titlebar">
        <div class="dw-window-title"><Icon name="fileText" cls="ico sm" /><span>{title}</span></div>
        <button class="iconbtn" {...tip(t("在主窗口中打开"))} onClick={() => void bridge.openMain(id).catch((e) => setError(e.message))}><Icon name="externalLink" /></button>
      </div>
      <div class="topbar dw-toolbar">
        <div class="crumb">
          <Icon name="fileText" cls="ico sm" />
          {path.slice(-2).map((segment) => <span class="dw-path" key={segment.id}>
            <button class="crumb-link" onClick={() => { location.hash = `#/${segment.kind}/${segment.id}`; }}>{segment.label}</button>
            <span class="crumb-sep">/</span>
          </span>)}
          <span class="dw-current">{title}</span>
        </div>
        <button class={`dw-save dw-save-${saving}`} title={label} aria-label={label} onClick={() => void handle.current?.flushSave()} disabled={!handle.current || saving === "saving" || saving === "saved"}>
          <Icon name={saving === "saved" ? "check" : saving === "error" || saving === "conflict" ? "alert" : "upload"} cls="ico sm" />
          <span role="status">{label}</span>
        </button>
        <button class="btn btn-secondary" disabled={!active} onClick={() => openShareModal({ kind: "doc", ref: id, title })}><Icon name="share" cls="ico sm" /><span>{t("分享")}</span></button>
        <button class="iconbtn" {...tip(t("更多"))} onClick={menu}><Icon name="dots" /></button>
      </div>
      {error && <ErrorBar msg={error} onClose={() => setError("")} />}
      {ready && !active && <ErrorBar msg={t("文档不存在或已被删除。未保存内容仍可导出。")} onClose={() => {}} />}
      <div class="content dw-content">
        {(!ready || active || hadDocument.current) && <DocView docId={id} wide={wide} onError={setError} onHandle={register} onModeChange={setMode} onSaveState={onSaveState} />}
      </div>
      <div class="dw-footer"><span>{mode === "source" ? t("源码") : "Markdown"}</span></div>
    </div>
    {history && <DocHistoryPanel docId={id} onClose={() => setHistory(false)} onReverted={() => handle.current?.reload()} />}
    <UiHost />
  </>;
}
