/** @jsxImportSource preact */
import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, type Db, type DocSummary, type Hit, NAV_INVALIDATE } from "./api.ts";
import { Icon } from "./icons.tsx";
import { Sidebar } from "./sidebar.tsx";
import { DatabaseView } from "./table.tsx";
import { DocView, type DocMode, type DocViewHandle } from "./editor.tsx";
import { SettingsView, cmpVer } from "./settings.tsx";
import { SitesView } from "./sites.tsx";
import { syncResolvedTheme, syncThemeColor } from "./theme.ts";
import { QuickNote } from "./quicknote/quicknote.tsx";
import { databaseToCsv, downloadText, safeFilename } from "./export.ts";
import {
  UiHost,
  openMenu,
  MenuItem,
  MenuSep,
  confirmDialog,
  promptDialog,
  toast,
} from "./ui.tsx";

// Single-page Preact app: browse/edit databases (Notion-like tables) and
// documents (block WYSIWYG). All writes go through /api/*, which call the same
// core functions the CLI uses, so changes land in the CRDT oplog and replicate.

type View =
  | { kind: "empty" }
  | { kind: "db"; id: string }
  | { kind: "doc"; id: string }
  | { kind: "search"; q: string }
  | { kind: "settings" }
  | { kind: "sites" };

// --- hash routing ------------------------------------------------------------
// Views are mirrored to "#/" routes so browser history (and a phone's hardware
// back) navigates the app, deep links survive a refresh, and doc/db URLs are
// shareable. The desktop Quick Notes window owns the bare "#quick" hash; it
// never matches a "#/" route and parses to the empty view in a plain browser.

function viewToHash(v: View): string {
  switch (v.kind) {
    case "db": return `#/db/${encodeURIComponent(v.id)}`;
    case "doc": return `#/doc/${encodeURIComponent(v.id)}`;
    case "search": return `#/search?q=${encodeURIComponent(v.q)}`;
    case "settings": return "#/settings";
    case "sites": return "#/sites";
    case "empty": return "#/";
  }
}

/** Inverse of viewToHash; anything unrecognized (or with malformed escapes) is
 *  the empty view, so a hand-mangled URL degrades to the home screen. */
function parseHash(h: string): View {
  if (!h.startsWith("#/")) return { kind: "empty" };
  const [path = "", query = ""] = h.slice(2).split("?", 2);
  const [kind, id = ""] = path.split("/", 2);
  try {
    if (kind === "db" && id) return { kind: "db", id: decodeURIComponent(id) };
    if (kind === "doc" && id) return { kind: "doc", id: decodeURIComponent(id) };
    if (kind === "search") {
      const q = new URLSearchParams(query).get("q");
      if (q) return { kind: "search", q };
    }
    if (kind === "settings") return { kind: "settings" };
    if (kind === "sites") return { kind: "sites" };
  } catch {
    // malformed percent-escape — treat as unrecognized
  }
  return { kind: "empty" };
}

const MOBILE_MQ = "(max-width: 768px) and (pointer: coarse)";

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

  useEffect(() => {
    setDocMode("blocks");
  }, [activeDocId]);

  // Reflect the mobile navigation state onto <body> (same body-class pattern as
  // `desktop`/`quicknote`): `mobile` swaps to the full-page sidebar layout, and
  // `mobile-content` slides the picked view in over it. Then retint the status
  // bar to whatever surface now fills the top of the screen.
  const contentActive = view.kind !== "empty";
  useEffect(() => {
    document.body.classList.toggle("mobile", isMobile);
    document.body.classList.toggle("mobile-content", isMobile && contentActive);
    syncThemeColor();
  }, [isMobile, contentActive]);

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
          <MenuItem icon="download" label="导出 Markdown" onClick={() => { close(); exportDocMarkdown(activeDoc); }} />
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
          <MenuItem icon="download" label="导出 CSV" onClick={() => { close(); exportDbCsv(activeDb); }} />
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
        activeKind={view.kind}
        activeId={"id" in view ? view.id : undefined}
        width={sbWidth}
        collapsed={sbCollapsed}
        onResize={setSbWidth}
        onOpenDb={(id) => navigate({ kind: "db", id })}
        onOpenDoc={(id) => navigate({ kind: "doc", id })}
        onSearch={(q) =>
          // entering search pushes once; retyping within it replaces, so one
          // back press leaves search instead of replaying every query
          navigate({ kind: "search", q }, { replace: view.kind === "search" })
        }
        onCollapse={() => setSbCollapsed(true)}
        onOpenSettings={() => navigate({ kind: "settings" })}
        settingsActive={view.kind === "settings"}
        onOpenSites={() => navigate({ kind: "sites" })}
        sitesActive={view.kind === "sites"}
        updatePending={updatePending}
        onError={onError}
        afterDelete={(_, id) => {
          // replace, not push: a deleted entity must not stay reachable via forward
          if ("id" in view && view.id === id) navigate({ kind: "empty" }, { replace: true });
        }}
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
          class="error-bar"
          style={{ background: "var(--surface)", color: "var(--fg)", margin: "0 0 8px" }}
          onClick={() => (h.type === "document" ? onOpenDoc(h.id) : h.database_id && onOpenDb(h.database_id))}
        >
          <strong>{h.title || h.id}</strong> <span class="muted">{h.type}</span>
          <div class="muted" dangerouslySetInnerHTML={{ __html: h.snippet }} />
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
