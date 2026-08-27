/** @jsxImportSource preact */
import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, type Db, type DocSummary, type Hit, NAV_INVALIDATE } from "./api.ts";
import { primeDocTitles } from "./doc-titles.ts";
import {
  resumeReplicaIfEnabled,
  replicaActive,
  replicaEnabled,
  clientMode,
  detectOriginMode,
  ensurePwaRegistration,
  startReplica,
  onReplicaStatus,
  replicaStatus,
  syncReplicaNow,
  isNoOrigin,
  REPLICA_LIFECYCLE_EVENT,
  type ReplicaLifecycle,
} from "./data/replica.ts";
import { Enroll } from "./enroll.tsx";
import { Icon } from "./icons.tsx";
import { Sidebar } from "./sidebar.tsx";
import { DatabaseView } from "./table.tsx";
import { DocView, type DocMode, type DocViewHandle } from "./editor.tsx";
import { SettingsView } from "./settings.tsx";
import { resolvePage, pageLabel } from "./settings/nav.ts";
import { cmpVer } from "./version.ts";
import { SitesView } from "./sites.tsx";
import { openShareModal } from "./share-modal.tsx";
import { ShareView } from "./shares-view.tsx";
import { syncResolvedTheme, syncThemeColor } from "./theme.ts";
import { useHistoryNav, goBack, goForward } from "./nav-history.ts";
import { type View, parseHash, viewToHash } from "./view.ts";
import { QuickNote } from "./quicknote/quicknote.tsx";
import { QuickBoard } from "./quickboard/quickboard.tsx";
import { ensureLive } from "./live.ts";
import { ImagePreviewWindow } from "./media/image-preview-window.tsx";
import { FileEditorWindow } from "./fileviewer/file-editor.tsx";
import { DocHistoryPanel } from "./history.tsx";
import { DbActivityPanel } from "./history-record.tsx";
import { databaseToCsv, relationTitleMaps, downloadText, safeFilename } from "./export.ts";
import {
  UiHost,
  openMenu,
  MenuItem,
  MenuSep,
  confirmDialog,
  promptDialog,
  toast,
  MOBILE_MQ,
} from "./ui.tsx";

// Single-page Preact app: browse/edit databases (Notion-like tables) and
// documents (block WYSIWYG). All writes go through /api/*, which call the same
// core functions the CLI uses, so changes land in the CRDT oplog and replicate.
// The View type and its hash mapping live in src/webui/view.ts.

// Drive the mobile navigation model off device capability, not UA sniffing: a
// narrow window only flips to the full-page-sidebar layout on a *touch* device
// (coarse pointer) — so resizing a desktop window never snaps it into mobile,
// which was the source of the size jitter. Rotation/resize still update live.
// Same query the mobile CSS in src/webui/styles.css keys off, so JS+CSS lockstep.
function useIsMobile(): boolean {
  const [m, setM] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_MQ).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

function App() {
  const [databases, setDatabases] = useState<Db[]>([]);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [view, setView] = useState<View>(() => parseHash(location.hash));
  const [error, setError] = useState("");
  const [sbCollapsed, setSbCollapsed] = useState(false);
  const [sbWidth, setSbWidth] = useState(268);
  const [docMode, setDocMode] = useState<DocMode>("blocks");
  const [docWide, setDocWide] = useState(false);
  // Deep links can name a db before the nav lists arrive (or a bogus id);
  // distinguishes "still loading" from "genuinely not found" below.
  const [navReady, setNavReady] = useState(false);
  const [updatePending, setUpdatePending] = useState(false);
  const [docHistory, setDocHistory] = useState(false);
  const [dbActivity, setDbActivity] = useState(false);
  const [replicaSt, setReplicaSt] = useState(() => replicaStatus());
  const [saveFlash, setSaveFlash] = useState(false);
  const [kbdPulse, setKbdPulse] = useState(false);
  const docHandleRef = useRef<DocViewHandle | null>(null);
  const hadBucketWork = useRef(false);
  // Holds the latest ⌘S/Ctrl+S handler so the once-bound keydown listener below
  // always sees current saveState/view without re-subscribing. Returns true when
  // it handled the key (caller then preventDefaults the browser "save page").
  const saveHotkeyRef = useRef<(() => boolean) | null>(null);
  const isMobile = useIsMobile();
  // Desktop windows have no browser chrome, so the topbar grows back/forward
  // buttons (and shortcuts below); the actual traversal is the browser's own.
  const isDesktop = typeof window !== "undefined" && !!window.metahubDesktop;
  const { canGoBack, canGoForward } = useHistoryNav();

  const onError = useCallback((m: string) => setError(m), []);
  const registerDocHandle = useCallback((handle: DocViewHandle | null) => {
    docHandleRef.current = handle;
  }, []);

  const reloadNav = useCallback(async () => {
    const [d, o] = await Promise.all([api.listDatabases(), api.listDocuments()]);
    setDatabases(d);
    setDocs(o);
    primeDocTitles(o, d); // free ride for [[doclink]] title resolution
    setNavReady(true);
  }, []);

  useEffect(() => {
    reloadNav().catch((e) => onError(String(e.message)));
  }, [reloadNav]);

  // Any successful database/document mutation (api.ts dispatches NAV_INVALIDATE)
  // refreshes the nav here — the single subscription replaces the manual
  // reloadNav() calls that used to be scattered across every mutation site.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const on = () => {
      clearTimeout(timer);
      timer = setTimeout(() => reloadNav().catch((e) => onError(String(e.message))), 80);
    };
    document.addEventListener(NAV_INVALIDATE, on);
    return () => {
      clearTimeout(timer);
      document.removeEventListener(NAV_INVALIDATE, on);
    };
  }, [reloadNav, onError]);

  // Offline replica: if this browser enabled it (settings → 离线副本), boot
  // the DB worker and nudge a sync; api.ts routes data calls to it once ready.
  // Skip inside the desktop shell: there the local sidecar is the data home, so
  // the renderer stays a pure window onto it — a renderer-side OPFS replica would
  // be redundant and (via api.ts's replicaActive() routing) shadow the sidecar's
  // on-disk DB. A leftover mh_replica flag from a prior version is ignored here.
  useEffect(() => {
    if (clientMode().surface === "desktop") return;
    resumeReplicaIfEnabled();
  }, []);

  useEffect(() => onReplicaStatus((s) => setReplicaSt({ ...s })), []);

  useEffect(() => {
    const pending = Boolean(replicaSt.bucketDirty || replicaSt.bucketSyncing);
    if (pending) {
      hadBucketWork.current = true;
      setSaveFlash(false);
      return;
    }
    if (!hadBucketWork.current || replicaSt.bucketError) return;
    hadBucketWork.current = false;
    setSaveFlash(true);
    const timer = setTimeout(() => setSaveFlash(false), 900);
    return () => clearTimeout(timer);
  }, [replicaSt.bucketDirty, replicaSt.bucketSyncing, replicaSt.bucketError]);

  // PWA: register the service worker only for a replica-holding client (trusted
  // device or no-origin bucket home). A lightweight online-only window keeps no
  // SW — a leftover one would intercept /api/* and surface a raw offline
  // ERR_CONNECTION_REFUSED — so ensurePwaRegistration() tears any stale one down.
  // Deferred behind detectOriginMode() so clientMode() (isNoOrigin) is settled
  // first; it also wires the one-shot auto-reload when a new SW version takes over.
  useEffect(() => {
    void detectOriginMode().then(() => ensurePwaRegistration());
  }, []);

  // Online/offline indicator: phase 1 offline is a stale read-only mirror, so
  // surface the state instead of letting writes fail mysteriously.
  const [offline, setOffline] = useState(typeof navigator !== "undefined" && !navigator.onLine);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Desktop only, no network: light the "设置" sidebar dot if a newer core is
  // already staged on disk (installed > running) — typically downloaded by the
  // app's silent startup auto-updater — and only waiting for a restart.
  useEffect(() => {
    const cu = typeof window !== "undefined" ? window.metahubDesktop?.coreUpdate : undefined;
    if (!cu) return;
    Promise.all([
      api.version().then((v) => v.version).catch(() => null),
      cu.installedVersion().catch(() => null),
    ]).then(([running, installed]) => {
      if (running && installed && cmpVer(installed, running) > 0) setUpdatePending(true);
    });
  }, []);

  // Single-writer rule: every view change goes through navigate() (which keeps
  // the hash in sync), except the hashchange listener below reacting to the
  // browser's own back/forward. pushState doesn't fire hashchange, so the two
  // writers never echo each other.
  const navigate = (v: View, opts?: { replace?: boolean }) => {
    const h = viewToHash(v);
    if (location.hash !== h) {
      history[opts?.replace ? "replaceState" : "pushState"](null, "", h);
    }
    setView(v);
  };

  useEffect(() => {
    // Normalize a stray non-route hash (e.g. a browser opening /#quick) so
    // later pushes don't stack on top of it.
    if (location.hash && !location.hash.startsWith("#/")) {
      history.replaceState(null, "", "#/");
    }
    const on = () => setView(parseHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  // The desktop file-editor window's 「在 MetaHub 中打开」: it broadcasts the id
  // of the freshly imported document (same origin) and raises this window via
  // IPC; deep-link straight to the doc.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("mh-open-doc");
    ch.onmessage = (e) => {
      const id = (e.data as { id?: unknown })?.id;
      if (typeof id === "string" && id) navigate({ kind: "doc", id });
    };
    return () => ch.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Same deep-link via IPC: the disk-loaded (file://) file-editor window can't
  // reach the same-origin BroadcastChannel above, so the main process forwards
  // the id (mh:open-doc). Double delivery from an http #file window is
  // harmless — both navigate to the same doc.
  useEffect(() => {
    const sub = typeof window !== "undefined" ? window.metahubDesktop?.onOpenDoc : undefined;
    if (!sub) return;
    return sub((id) => navigate({ kind: "doc", id }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newEmptyDoc = () =>
    api.createDocument({ title: "" })
      .then((d) => navigate({ kind: "doc", id: d.id }))
      .catch((e) => onError(String(e.message)));

  const activeDb = view.kind === "db" ? databases.find((d) => d.id === view.id) : undefined;
  const activeDoc = view.kind === "doc" ? docs.find((d) => d.id === view.id) : undefined;
  const activeDocId = view.kind === "doc" ? view.id : null;
  const activeDbId = view.kind === "db" ? view.id : null;

  useEffect(() => {
    setDocMode("blocks");
    setDocHistory(false);
    setDocWide(!!activeDocId && localStorage.getItem(`mh.doc-wide.${activeDocId}`) === "1");
  }, [activeDocId]);

  useEffect(() => {
    setDbActivity(false);
  }, [activeDbId]);

  // Reflect the mobile navigation state onto <body> (same body-class pattern as
  // `desktop`/`quicknote`): `mobile` swaps to the full-page sidebar layout, and
  // `mobile-content` shows the picked view instead of it. Both views share the
  // *document* scroll (the layout is in normal flow on mobile — structural for
  // iOS 26 Safari's chrome, see styles.css), so hide/show drops the position:
  // remember the home list offset across a detour into content, and start every
  // newly opened view at the top. `view` is a dep so doc→doc jumps reset too.
  const contentActive = view.kind !== "empty";
  const homeScroll = useRef(0);
  useEffect(() => {
    const nowContent = isMobile && contentActive;
    if (nowContent && !document.body.classList.contains("mobile-content"))
      homeScroll.current = window.scrollY;
    document.body.classList.toggle("mobile", isMobile);
    document.body.classList.toggle("mobile-content", nowContent);
    syncThemeColor();
    if (isMobile) window.scrollTo(0, nowContent ? 0 : homeScroll.current);
  }, [isMobile, contentActive, view]);

  // ⌘K / Ctrl+K — the shortcut behind the search box's kbd badge: focus the
  // sidebar search from anywhere (same DOM reach the box's own click handler
  // uses, see sidebar.tsx).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      // ⌘[ / ⌘] (mac) 或 Alt+←/→ — desktop page back/forward, same traversal
      // as the topbar nav buttons. Editors claim overlapping keys first (CM6
      // binds Mod-[ to indent, Alt-Arrow to syntax moves) and preventDefault
      // before this non-capture listener runs, so honor that.
      if (isDesktop && !e.defaultPrevented) {
        const mac = window.metahubDesktop?.platform === "darwin";
        const back = mac ? e.metaKey && e.key === "[" : e.altKey && e.key === "ArrowLeft";
        const fwd = mac ? e.metaKey && e.key === "]" : e.altKey && e.key === "ArrowRight";
        if (back || fwd) {
          e.preventDefault();
          (back ? goBack : goForward)();
          return;
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".sb-search input")?.focus();
        return;
      }
      // ⌘S / Ctrl+S — save to the cloud bucket instead of the browser's "save
      // page". Delegates to the latest render's handler (see saveHotkeyRef).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if (saveHotkeyRef.current?.()) e.preventDefault();
      }
      // ⌘/ / Ctrl+/ — toggle the doc's source ⇄ blocks view (the "code mode"
      // menu item's shortcut). docHandleRef is non-null only in a doc view, so
      // this no-ops elsewhere; getMode() keeps it fresh past this empty-dep
      // effect's closure.
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        const h = docHandleRef.current;
        if (h) {
          e.preventDefault();
          h.setMode(h.getMode() === "source" ? "blocks" : "source");
        }
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // When following the system theme, the OS flipping dark/light must re-resolve
  // <html data-resolved> (CSS keys off it alone — see theme.ts) and then retint
  // the status bar to the surface that just changed under it.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => {
      syncResolvedTheme();
      syncThemeColor();
    };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // Export actions, shared between the "…" menu and the share menu.
  const exportDocMarkdown = (doc: DocSummary) => {
    const body = docHandleRef.current?.snapshotMarkdown();
    docHandleRef.current?.flushSave();
    const fallback = body == null ? api.getDocument(doc.id).then((d) => d.body ?? "") : Promise.resolve(body);
    fallback
      .then((text) => downloadText(safeFilename(doc.title || doc.id, ".md"), text, "text/markdown;charset=utf-8"))
      .catch((err) => onError(String(err.message)));
  };
  const exportDbCsv = (db: Db) => {
    Promise.all([api.listProperties(db.id), api.listRecords(db.id)])
      .then(async ([props, records]) =>
        downloadText(
          safeFilename(db.name || db.id, ".csv"),
          databaseToCsv(props, records, await relationTitleMaps(props)),
          "text/csv;charset=utf-8",
        ),
      )
      .catch((err) => onError(String(err.message)));
  };

  const shareMenu = (e: MouseEvent) => {
    openMenu(e, (close) => (
      <>
        <MenuItem icon="link" label="复制链接" onClick={() => {
          close();
          // The hash route *is* the shareable address (same host).
          navigator.clipboard.writeText(location.origin + location.pathname + viewToHash(view))
            .then(() => toast("链接已复制"))
            .catch((err) => onError(String(err.message)));
        }} />
        {(view.kind === "doc" || view.kind === "db") && (
          <MenuItem icon="file" label="复制内链" onClick={() => {
            close();
            // `[[id]]` — origin-free internal reference; pasting it into any
            // document renders a live link to this target on every device.
            navigator.clipboard.writeText(`[[${view.id}]]`)
              .then(() => toast("内链已复制，可粘贴到任意文档"))
              .catch((err) => onError(String(err.message)));
          }} />
        )}
        {view.kind === "doc" && activeDoc && (
          <MenuItem icon="link" label="通过设备分享…" onClick={() => { close(); openShareModal({ kind: "doc", ref: activeDoc.id, title: activeDoc.title }); }} />
        )}
        {view.kind === "db" && activeDb && (
          <MenuItem icon="link" label="通过设备分享…" onClick={() => { close(); openShareModal({ kind: "database", ref: activeDb.id, title: activeDb.name }); }} />
        )}
        {view.kind === "doc" && activeDoc && (
          <MenuItem icon="download" label="导出 Markdown" onClick={() => { close(); exportDocMarkdown(activeDoc); }} />
        )}
        {view.kind === "db" && activeDb && (
          <MenuItem icon="download" label="导出 CSV" onClick={() => { close(); exportDbCsv(activeDb); }} />
        )}
      </>
    ));
  };

  const saveState =
    replicaActive() && (replicaSt.bucketDirty || replicaSt.bucketSyncing || replicaSt.bucketError || saveFlash)
      ? replicaSt.bucketSyncing
        ? "saving"
        : saveFlash
          ? "saved"
          : replicaSt.bucketError
            ? "error"
            : "dirty"
      : "share";
  const saveLabel =
    saveState === "saving"
      ? "保存中…"
      : saveState === "saved"
        ? "已保存"
        : saveState === "share"
          ? "分享"
          : "保存";
  const saveIcon =
    saveState === "share"
      ? "share"
      : saveState === "saved"
        ? "cloudCheck"
        : saveState === "saving"
          ? "spinner"
          : saveState === "error"
            ? "cloudOff"
            : "cloudUp";
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const saveHint = isMobile ? "" : isMac ? " · ⌘S" : " · Ctrl+S";
  const shareSaveTitle =
    saveState === "share"
      ? "分享"
      : saveState === "error"
        ? `保存到同步存储桶失败：${replicaSt.bucketError ?? ""}`
        : `保存到同步存储桶${saveHint}`;

  // Quiet success / loud failure: success rides on the inline "已保存" flash
  // (saveFlash, see above), so no success toast — we only shout on failure.
  // Shared by the button click and the ⌘S shortcut.
  const saveToBucket = async () => {
    try {
      await docHandleRef.current?.flushSave();
      await syncReplicaNow();
      const st = replicaStatus();
      if (st.bucketError) throw new Error(st.bucketError);
      if (st.bucketDirty) throw new Error("仍有改动尚未保存到同步存储桶");
    } catch (err) {
      toast(`保存失败：${(err as Error).message}`);
    }
  };

  const triggerKbdPulse = () => {
    setKbdPulse(true);
    window.setTimeout(() => setKbdPulse(false), 320);
  };

  const shareSaveClick = (e: MouseEvent) => {
    if (saveState === "share") {
      shareMenu(e);
      return;
    }
    if (saveState === "saving" || saveState === "saved") return;
    void saveToBucket();
  };

  // ⌘S / Ctrl+S — re-bound each render so the once-bound listener sees fresh state.
  saveHotkeyRef.current = () => {
    if (view.kind !== "doc" && view.kind !== "db") return false; // leave default elsewhere
    if (saveState === "saving" || saveState === "saved") return true; // already in flight
    if (saveState === "dirty" || saveState === "error") {
      void saveToBucket();
      triggerKbdPulse();
    } else if (replicaActive()) {
      toast("已是最新"); // synced — nothing to push, just acknowledge
      triggerKbdPulse();
    }
    return true; // doc/db view → swallow the browser "save page" regardless
  };

  // Wide mode lifts the 740px column cap (.doc.wide-mode). Remembered
  // per-document but device-local: documents carry no UI metadata in core,
  // so localStorage is the store.
  const toggleDocWide = () => {
    if (!activeDocId) return;
    const next = !docWide;
    setDocWide(next);
    try {
      if (next) localStorage.setItem(`mh.doc-wide.${activeDocId}`, "1");
      else localStorage.removeItem(`mh.doc-wide.${activeDocId}`);
    } catch { /* private mode: the toggle just doesn't persist */ }
  };

  const moreMenu = (e: MouseEvent) => {
    if (view.kind === "doc" && activeDoc) {
      openMenu(e, (close) => (
        <>
          <MenuItem icon="code" label={docMode === "source" ? "块方式显示" : "代码方式显示"} kbd={isMac ? "⌘/" : "Ctrl /"} checked={docMode === "source"} onClick={() => {
            close();
            docHandleRef.current?.setMode(docMode === "source" ? "blocks" : "source");
          }} />
          <MenuItem icon="maximize" label="宽屏模式" checked={docWide} onClick={() => {
            close();
            toggleDocWide();
          }} />
          <MenuItem icon="copy" label="创建副本" onClick={async () => {
            close();
            // The copy is made server-side, so flush pending edits first.
            docHandleRef.current?.flushSave();
            try {
              const d = await api.duplicateDocument(activeDoc.id, { title: `${activeDoc.title || "无标题"} 副本` });
              navigate({ kind: "doc", id: d.id });
              toast("已创建副本");
            } catch (err) { onError(String((err as Error).message)); }
          }} />
          <MenuItem icon="history" label="版本历史" onClick={() => {
            close();
            // Flush pending edits first so the history list includes them.
            docHandleRef.current?.flushSave();
            setDocHistory(true);
          }} />
          <MenuSep />
          <MenuItem icon="hash" label="复制 ID" onClick={() => {
            close();
            navigator.clipboard?.writeText(activeDoc.id).then(() => toast("已复制 ID"));
          }} />
          <MenuItem icon="settings" label="重命名…" onClick={async () => {
            close();
            const title = await promptDialog({ title: "重命名文档", value: activeDoc.title });
            if (title) await api.updateDocument(activeDoc.id, { title });
          }} />
          <MenuSep />
          <MenuItem icon="trash" label="删除文档" danger onClick={async () => {
            close();
            const ok = await confirmDialog({ title: "删除文档？", message: `「${activeDoc.title || "无标题"}」将被删除。`, confirmLabel: "删除", danger: true });
            if (ok) { await api.deleteDocument(activeDoc.id); navigate({ kind: "empty" }, { replace: true }); }
          }} />
        </>
      ));
    } else if (view.kind === "db" && activeDb) {
      openMenu(e, (close) => (
        <>
          <MenuItem icon="copy" label="创建副本" onClick={async () => {
            close();
            try {
              const nd = await api.duplicateDatabase(activeDb.id, { name: `${activeDb.name} 副本` });
              navigate({ kind: "db", id: nd.id });
              toast("已创建副本");
            } catch (err) { onError(String((err as Error).message)); }
          }} />
          <MenuItem icon="history" label="最近动态" onClick={() => { close(); setDbActivity(true); }} />
          <MenuSep />
          <MenuItem icon="hash" label="复制 ID" onClick={() => {
            close();
            navigator.clipboard?.writeText(activeDb.id).then(() => toast("已复制 ID"));
          }} />
          <MenuItem icon="settings" label="重命名…" onClick={async () => {
            close();
            const name = await promptDialog({ title: "重命名数据库", value: activeDb.name });
            if (name && name !== activeDb.name) await api.updateDatabase(activeDb.id, { name });
          }} />
          <MenuSep />
          <MenuItem icon="trash" label="删除数据库" danger onClick={async () => {
            close();
            const ok = await confirmDialog({ title: "删除数据库？", message: `「${activeDb.name}」及其所有记录将被永久删除。`, confirmLabel: "删除", danger: true });
            if (ok) { await api.deleteDatabase(activeDb.id); navigate({ kind: "empty" }, { replace: true }); }
          }} />
        </>
      ));
    }
  };

  return (
    <>
      <Sidebar
        databases={databases}
        docs={docs}
        view={view}
        navigate={navigate}
        width={sbWidth}
        collapsed={sbCollapsed}
        onResize={setSbWidth}
        onCollapse={() => setSbCollapsed(true)}
        updatePending={updatePending}
        onError={onError}
      />
      <div class="main">
        <div class={"topbar" + (view.kind === "empty" ? " bare" : "")}>
          <button
            class={"iconbtn hamburger" + (sbCollapsed ? " show-collapsed" : "")}
            title={isMobile ? "返回" : sbCollapsed ? "展开侧栏" : "菜单"}
            onClick={() => (isMobile ? navigate({ kind: "empty" }) : setSbCollapsed(false))}
          >
            <Icon name={isMobile ? "arrowLeft" : "panelLeft"} />
          </button>
          {isDesktop && !isMobile && (
            <>
              <button class="iconbtn navbtn" title="后退" disabled={!canGoBack} onClick={goBack}>
                <Icon name="arrowLeft" />
              </button>
              <button class="iconbtn navbtn" title="前进" disabled={!canGoForward} onClick={goForward}>
                <Icon name="arrowRight" />
              </button>
            </>
          )}
          <div class="crumb">
            {view.kind === "doc" && <><span class="emoji"><Icon name="file" cls="ico sm" /></span><span>{activeDoc?.title || "无标题"}</span></>}
            {view.kind === "db" && <><span class="emoji">{activeDb?.icon || "🗂️"}</span><span>{activeDb?.name}</span></>}
            {view.kind === "search" && <span>搜索：“{view.q}”</span>}
            {view.kind === "settings" && (
              <>
                <span class="emoji"><Icon name="settings" cls="ico sm" /></span>
                {view.sec !== undefined ? (
                  <>
                    <button class="crumb-link" onClick={() => navigate({ kind: "settings" })}>设置</button>
                    <span class="crumb-sep">›</span>
                    <span>{pageLabel(resolvePage(view.sec))}</span>
                  </>
                ) : (
                  <span>设置</span>
                )}
              </>
            )}
            {view.kind === "sites" && <><span class="emoji"><Icon name="globe" cls="ico sm" /></span><span>站点管理</span></>}
            {view.kind === "shares" && <><span class="emoji"><Icon name="link" cls="ico sm" /></span><span>分享</span></>}
          </div>
          {(view.kind === "doc" || view.kind === "db") && (
            <>
              <button
                class={`btn share-save share-save-${saveState}${kbdPulse ? " share-save-kbd" : ""}`}
                title={shareSaveTitle}
                disabled={saveState === "saving" || saveState === "saved"}
                onClick={shareSaveClick}
              >
                <span class="share-save-ico"><Icon name={saveIcon} cls="ico sm" /></span>
                <span class="share-save-label">{saveLabel}</span>
              </button>
              <button class="iconbtn" onClick={moreMenu}><Icon name="dots" /></button>
            </>
          )}
        </div>

        {offline && (
          <div class="offline-bar">
            {replicaActive()
              ? "⚡ 离线 — 本地副本模式:可正常查看和编辑全部内容,恢复连接后自动同步"
              : "⚡ 离线 — 可浏览已缓存的内容,修改会失败;恢复网络后自动恢复"}
          </div>
        )}
        {error && <div class="error-bar" onClick={() => setError("")}>⚠ {error}（点击关闭）</div>}

        <div class="content">
          {view.kind === "empty" && <EmptyState onNewDoc={newEmptyDoc} />}
          {view.kind === "db" && activeDb && (
            <DatabaseView
              key={activeDb.id}
              db={activeDb}
              rec={view.rec ?? null}
              onRecNav={(r) => navigate({ kind: "db", id: activeDb.id, rec: r ?? undefined }, { replace: true })}
              onError={onError}
            />
          )}
          {view.kind === "db" && !activeDb && (
            <div class="empty">{navReady ? "数据库不存在或已被删除。" : "加载中…"}</div>
          )}
          {view.kind === "doc" && (
            <DocView
              key={view.id}
              docId={view.id}
              wide={docWide}
              onError={onError}
              onModeChange={setDocMode}
              onHandle={registerDocHandle}
            />
          )}
          {view.kind === "search" && (
            <SearchView q={view.q} onOpenDoc={(id) => navigate({ kind: "doc", id })} onOpenDb={(id) => navigate({ kind: "db", id })} />
          )}
          {view.kind === "settings" && <SettingsView onUpdatePending={setUpdatePending} updatePending={updatePending} focusSec={view.sec} />}
          {view.kind === "sites" && <SitesView />}
          {view.kind === "shares" && <ShareView onNavigate={navigate} />}
        </div>
      </div>

      {docHistory && view.kind === "doc" && (
        <DocHistoryPanel
          docId={view.id}
          onClose={() => setDocHistory(false)}
          onReverted={() => docHandleRef.current?.reload()}
        />
      )}
      {dbActivity && view.kind === "db" && (
        <DbActivityPanel dbId={view.id} onClose={() => setDbActivity(false)} />
      )}

      <UiHost />
    </>
  );
}

/** Right-pane placeholder shown when nothing is selected: a "knowledge growth"
 *  illustration (a sprout growing from a document card) that animates in, then
 *  gently sways. Pure CSS/SVG — styles live in src/webui/styles.css. */
function EmptyState({ onNewDoc }: { onNewDoc: () => void }) {
  return (
    <div class="empty">
      <svg class="estate-art" viewBox="0 0 220 190" fill="none" aria-hidden="true">
        <ellipse class="kg-ground ground" cx="110" cy="176" rx="62" ry="8" />
        <circle class="kg-glow fill-soft" cx="116" cy="88" r="42" />
        <g class="kg-plant">
          <path class="kg-stem stroke-a draw" pathLength="100" d="M110 134 C110 117 108 106 113 92 C116 83 122 77 128 72" />
          <g class="kg-leaf l1"><g class="kg-grow"><path class="fill-a" d="M108 108 C90 100 86 88 88 80 C102 80 111 90 108 108 Z" /></g></g>
          <g class="kg-leaf l2"><g class="kg-grow"><path class="fill-a" d="M118 90 C133 83 144 86 150 94 C139 105 125 104 118 90 Z" /></g></g>
          <g class="kg-leaf l3"><g class="kg-grow"><path class="fill-a" d="M128 72 C128 57 136 48 146 45 C150 58 144 69 128 72 Z" /></g></g>
        </g>
        <rect class="kg-cardB fill-soft" x="76" y="124" width="68" height="44" rx="8" transform="rotate(7 110 146)" />
        <g class="kg-cardA">
          <rect class="fill-surface stroke" x="66" y="128" width="76" height="46" rx="9" transform="rotate(-5 104 151)" />
          <rect class="fill-a" x="74" y="136" width="18" height="18" rx="5" transform="rotate(-5 104 151)" />
          <rect class="fill-soft" x="98" y="139" width="34" height="6" rx="3" transform="rotate(-5 104 151)" />
          <rect class="fill-soft" x="98" y="150" width="24" height="6" rx="3" transform="rotate(-5 104 151)" />
        </g>
        <circle class="kg-particle p1 fill-a" cx="44" cy="62" r="2.6" />
        <circle class="kg-particle p2 fill-soft" cx="178" cy="74" r="3" />
        <circle class="kg-particle p3 fill-a" cx="40" cy="120" r="2" />
        <circle class="kg-particle p4 fill-soft" cx="182" cy="126" r="2.4" />
        <circle class="kg-particle p5 fill-a" cx="150" cy="44" r="2.2" />
      </svg>
      <p class="estate-title">空空如也</p>
      <p class="estate-hint">从左侧选择一个数据库或文档，或新建一个开始。</p>
      <button class="estate-link" onClick={onNewDoc}>＋ 新建文档</button>
    </div>
  );
}

/** FTS snippets are plain text with `[..]` wrapping each matched term (see
 *  core/search.ts). Render them as text nodes with <mark> around the wrapped
 *  spans — never as HTML, so document content can't inject markup. */
function SnippetText({ text }: { text: string }) {
  const parts = text.split(/\[([^\[\]]*)\]/g);
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
}

function SearchView({ q, onOpenDoc, onOpenDb }: { q: string; onOpenDoc: (id: string) => void; onOpenDb: (id: string) => void }) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  useEffect(() => {
    setHits(null);
    api.search(q).then(setHits).catch(() => setHits([]));
  }, [q]);
  return (
    <div class="db">
      <div class="db-title" style={{ marginBottom: 14 }}>搜索：“{q}”</div>
      {hits === null && <p class="muted">搜索中…</p>}
      {hits?.length === 0 && <p class="muted">没有匹配结果。</p>}
      {hits?.map((h) => (
        <div
          key={h.id}
          class="search-hit"
          onClick={() => (h.type === "document" ? onOpenDoc(h.id) : h.database_id && onOpenDb(h.database_id))}
        >
          <strong>{h.title || h.id}</strong> <span class="muted">{h.type === "document" ? "文档" : "记录"}</span>
          <div class="muted"><SnippetText text={h.snippet} /></div>
        </div>
      ))}
    </div>
  );
}

// ---- no-origin bootstrap (data-blind static shell) -------------------------
// When the shell is served by a metahub server (origin mode) Root renders <App>
// unchanged. When it's served from a data-blind static host (no-origin), there's
// no HTTP backend to fall back on, so Root gates: enroll a bucket first, hydrate
// the local replica, then render the app (all data routes to the replica). The
// shell never hardcodes a domain — it works off its own self.location.origin.

function Splash({ text }: { text: string }) {
  return (
    <div class="enroll-splash">
      <div class="enroll-spinner" />
      <div class="muted">{text}</div>
    </div>
  );
}

function Root() {
  const [mode, setMode] = useState<"detecting" | "app" | "enroll" | "hydrating">("detecting");

  useEffect(() => {
    void detectOriginMode().then((m) => {
      if (m === "server") return setMode("app"); // origin mode: unchanged behavior
      if (!replicaEnabled()) return setMode("enroll"); // no-origin, not yet connected
      startReplica(); // no-origin + already connected: boot replica, gate on hydration
      setMode(replicaActive() ? "app" : "hydrating");
    });
  }, []);

  // Window (HTTP) mode: open the live change feed so CLI/agent writes refresh
  // open views without a manual reload. ensureLive() itself no-ops for replica
  // and no-origin holds.
  useEffect(() => {
    if (mode === "app") ensureLive();
  }, [mode]);

  // Reset/disable can happen while <App> is already mounted. A no-origin shell
  // has no HTTP fallback, so transition immediately back to enrollment instead
  // of leaving a dead settings screen whose "enable" path calls /api/pair/new.
  useEffect(() => {
    const onLifecycle = (event: Event) => {
      const state = (event as CustomEvent<ReplicaLifecycle>).detail;
      if (state === "enabled") return;
      if (isNoOrigin()) setMode("enroll");
    };
    document.addEventListener(REPLICA_LIFECYCLE_EVENT, onLifecycle);
    return () => document.removeEventListener(REPLICA_LIFECYCLE_EVENT, onLifecycle);
  }, []);

  // Flip to the app once the bucket hydration completes.
  useEffect(() => {
    if (mode !== "hydrating") return;
    if (replicaActive()) return setMode("app");
    return onReplicaStatus(() => {
      if (replicaActive()) setMode("app");
    });
  }, [mode]);

  if (mode === "detecting") return <Splash text="加载中…" />;
  if (mode === "enroll")
    return <Enroll onDone={() => setMode(replicaActive() ? "app" : "hydrating")} />;
  if (mode === "hydrating") return <Splash text="正在从同步存储桶恢复本地副本…" />;
  return <App />;
}

// Inside the desktop shell, tag <body> so the WebUI can adapt its chrome: the
// frameless macOS window drops the sidebar logo and reserves a draggable strip
// for the inset traffic lights. A browser leaves these classes off entirely.
if (typeof window !== "undefined" && window.metahubDesktop) {
  document.body.classList.add("desktop");
  if (window.metahubDesktop.platform === "darwin") document.body.classList.add("desktop-mac");
  // Self-heal a leftover SW in EVERY desktop window, not just the main app:
  // the quicknote/preview windows never mount <Root/> (whose effect runs this),
  // so a SW registered by an older build would keep controlling them and could
  // serve a stale cached shell after a restart (network-first timeout fallback).
  ensurePwaRegistration(); // desktop surface → teardownPwa()
}

// The desktop Quick Notes window loads this same bundle at `…/#quick`. Mount the
// compact note view there — but only inside the desktop shell (guarded on the
// preload bridge), so a browser hitting `/#quick` just gets the full app.
// The desktop image-preview window loads this same bundle at `…/#preview?…`. It's
// a standalone full-window viewer — never boot the sidebar/replica app there.
if (location.hash.startsWith("#preview")) {
  document.body.classList.add("preview-window");
  render(<ImagePreviewWindow />, document.getElementById("app")!);
} else if (location.hash.startsWith("#file") && clientMode().surface === "desktop") {
  // The desktop file-editor window (.txt/.md "open with") — standalone editor
  // over an on-disk file; desktop-gated because it needs the preload file bridge.
  document.body.classList.add("file-window");
  render(<FileEditorWindow />, document.getElementById("app")!);
} else if (location.hash === "#quick" && clientMode().surface === "desktop") {
  document.body.classList.add("quicknote");
  ensureLive(); // CLI/agent edits refresh the open note + note list
  render(<QuickNote />, document.getElementById("app")!);
} else if (location.hash === "#board" && clientMode().surface === "desktop") {
  // The desktop Quick Board window — same bundle, same desktop-only gating as
  // the Quick Notes window above. Live feed is its whole point: agent-driven
  // `mh record update` calls move cards without a manual refresh.
  document.body.classList.add("quickboard");
  ensureLive();
  render(<QuickBoard />, document.getElementById("app")!);
} else {
  render(<Root />, document.getElementById("app")!);
}
