/** @jsxImportSource preact */
import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, type Db, type DocSummary, type Hit, NAV_INVALIDATE } from "./api.ts";
import { resumeReplicaIfEnabled, replicaActive } from "./data/replica.ts";
import { Icon } from "./icons.tsx";
import { Sidebar } from "./sidebar.tsx";
import { DatabaseView } from "./table.tsx";
import { DocView, type DocMode, type DocViewHandle } from "./editor.tsx";
import { SettingsView } from "./settings.tsx";
import { cmpVer } from "./version.ts";
import { SitesView } from "./sites.tsx";
import { syncResolvedTheme, syncThemeColor } from "./theme.ts";
import { type View, parseHash, viewToHash } from "./view.ts";
import { QuickNote } from "./quicknote/quicknote.tsx";
import { DocHistoryPanel, DbActivityPanel } from "./history.tsx";
import { databaseToCsv, downloadText, safeFilename } from "./export.ts";
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
  // Deep links can name a db before the nav lists arrive (or a bogus id);
  // distinguishes "still loading" from "genuinely not found" below.
  const [navReady, setNavReady] = useState(false);
  const [updatePending, setUpdatePending] = useState(false);
  const [docHistory, setDocHistory] = useState(false);
  const [dbActivity, setDbActivity] = useState(false);
  const docHandleRef = useRef<DocViewHandle | null>(null);
  const isMobile = useIsMobile();

  const onError = useCallback((m: string) => setError(m), []);
  const registerDocHandle = useCallback((handle: DocViewHandle | null) => {
    docHandleRef.current = handle;
  }, []);

  const reloadNav = useCallback(async () => {
    const [d, o] = await Promise.all([api.listDatabases(), api.listDocuments()]);
    setDatabases(d);
    setDocs(o);
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
  useEffect(() => {
    resumeReplicaIfEnabled();
  }, []);

  // PWA: register the service worker (offline shell + stale read mirror).
  // Secure-context only — plain-HTTP LAN setups keep today's behavior. On an
  // update taking control mid-session the running page is one bundle behind;
  // first-install claims are silent (hadController distinguishes the two).
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (!window.isSecureContext) return;
    const hadController = navigator.serviceWorker.controller != null;
    let notified = false;
    navigator.serviceWorker.register("/sw.js").catch((e) => {
      // Progressive enhancement — never block the app — but warn: a silent
      // failure here silently costs offline support.
      console.warn("[webui] service worker registration failed —", e);
    });
    const onChange = () => {
      if (!hadController || notified) return;
      notified = true;
      toast("界面已更新,刷新页面生效");
    };
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
    return () => navigator.serviceWorker.removeEventListener("controllerchange", onChange);
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".sb-search input")?.focus();
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
      .then(([props, records]) =>
        downloadText(safeFilename(db.name || db.id, ".csv"), databaseToCsv(props, records), "text/csv;charset=utf-8"),
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
        {view.kind === "doc" && activeDoc && (
          <MenuItem icon="download" label="导出 Markdown" onClick={() => { close(); exportDocMarkdown(activeDoc); }} />
        )}
        {view.kind === "db" && activeDb && (
          <MenuItem icon="download" label="导出 CSV" onClick={() => { close(); exportDbCsv(activeDb); }} />
        )}
      </>
    ));
  };

  const moreMenu = (e: MouseEvent) => {
    if (view.kind === "doc" && activeDoc) {
      openMenu(e, (close) => (
        <>
          <MenuItem icon="code" label={docMode === "source" ? "块方式显示" : "代码方式显示"} checked={docMode === "source"} onClick={() => {
            close();
            docHandleRef.current?.setMode(docMode === "source" ? "blocks" : "source");
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
          <div class="crumb">
            {view.kind === "doc" && <><span class="emoji"><Icon name="file" cls="ico sm" /></span><span>{activeDoc?.title || "无标题"}</span></>}
            {view.kind === "db" && <><span class="emoji">{activeDb?.icon || "🗂️"}</span><span>{activeDb?.name}</span></>}
            {view.kind === "search" && <span>搜索：“{view.q}”</span>}
            {view.kind === "settings" && <><span class="emoji"><Icon name="settings" cls="ico sm" /></span><span>设置</span></>}
            {view.kind === "sites" && <><span class="emoji"><Icon name="globe" cls="ico sm" /></span><span>站点管理</span></>}
          </div>
          {(view.kind === "doc" || view.kind === "db") && (
            <>
              <button class="btn btn-ghost" onClick={shareMenu}><Icon name="share" cls="ico sm" />分享</button>
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
            <DatabaseView key={activeDb.id} db={activeDb} onError={onError} />
          )}
          {view.kind === "db" && !activeDb && (
            <div class="empty">{navReady ? "数据库不存在或已被删除。" : "加载中…"}</div>
          )}
          {view.kind === "doc" && (
            <DocView
              key={view.id}
              docId={view.id}
              onError={onError}
              onModeChange={setDocMode}
              onHandle={registerDocHandle}
            />
          )}
          {view.kind === "search" && (
            <SearchView q={view.q} onOpenDoc={(id) => navigate({ kind: "doc", id })} onOpenDb={(id) => navigate({ kind: "db", id })} />
          )}
          {view.kind === "settings" && <SettingsView onUpdatePending={setUpdatePending} />}
          {view.kind === "sites" && <SitesView />}
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

// Inside the desktop shell, tag <body> so the WebUI can adapt its chrome: the
// frameless macOS window drops the sidebar logo and reserves a draggable strip
// for the inset traffic lights. A browser leaves these classes off entirely.
if (typeof window !== "undefined" && window.metahubDesktop) {
  document.body.classList.add("desktop");
  if (window.metahubDesktop.platform === "darwin") document.body.classList.add("desktop-mac");
}

// The desktop Quick Notes window loads this same bundle at `…/#quick`. Mount the
// compact note view there — but only inside the desktop shell (guarded on the
// preload bridge), so a browser hitting `/#quick` just gets the full app.
if (location.hash === "#quick" && typeof window !== "undefined" && window.metahubDesktop) {
  document.body.classList.add("quicknote");
  render(<QuickNote />, document.getElementById("app")!);
} else {
  render(<App />, document.getElementById("app")!);
}
