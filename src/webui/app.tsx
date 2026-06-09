/** @jsxImportSource preact */
import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, type Db, type DocSummary, type Hit } from "./api.ts";
import { Icon } from "./icons.tsx";
import { Sidebar } from "./sidebar.tsx";
import { DatabaseView } from "./table.tsx";
import { DocView, type DocMode, type DocViewHandle } from "./editor.tsx";
import { SettingsView, cmpVer } from "./settings.tsx";
import { SitesView } from "./sites.tsx";
import { syncThemeColor } from "./theme.ts";
import { QuickNote } from "./quicknote/quicknote.tsx";
import { databaseToCsv, downloadText, safeFilename } from "./export.ts";
import {
  UiHost,
  openMenu,
  MenuItem,
  MenuSep,
  confirmDialog,
  promptDialog,
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

const MOBILE_MQ = "(max-width: 768px) and (pointer: coarse)";

// Drive the mobile navigation model off device capability, not UA sniffing: a
// narrow window only flips to the full-page-sidebar layout on a *touch* device
// (coarse pointer) — so resizing a desktop window never snaps it into mobile,
// which was the source of the size jitter. Rotation/resize still update live.
// Same query the mobile CSS in core/sync/webui.ts keys off, so JS+CSS lockstep.
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
  const [view, setView] = useState<View>({ kind: "empty" });
  const [error, setError] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sbCollapsed, setSbCollapsed] = useState(false);
  const [sbWidth, setSbWidth] = useState(268);
  const [docMode, setDocMode] = useState<DocMode>("blocks");
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
  }, []);

  useEffect(() => {
    reloadNav().catch((e) => onError(String(e.message)));
  }, [reloadNav]);

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

  const navigate = (v: View) => {
    setView(v);
    setDrawerOpen(false);
  };

  const newEmptyDoc = () =>
    api.createDocument({ title: "" })
      .then((d) => { reloadNav(); navigate({ kind: "doc", id: d.id }); })
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

  // When following the system theme, the OS flipping dark/light changes the CSS
  // vars but fires no app event — retint the status bar on the media change too.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => syncThemeColor();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const moreMenu = (e: MouseEvent) => {
    if (view.kind === "doc" && activeDoc) {
      openMenu(e, (close) => (
        <>
          <MenuItem icon="code" label={docMode === "source" ? "块方式显示" : "代码方式显示"} checked={docMode === "source"} onClick={() => {
            close();
            docHandleRef.current?.setMode(docMode === "source" ? "blocks" : "source");
          }} />
          <MenuItem icon="download" label="导出 Markdown" onClick={() => {
            close();
            const body = docHandleRef.current?.snapshotMarkdown();
            docHandleRef.current?.flushSave();
            const fallback = body == null ? api.getDocument(activeDoc.id).then((d) => d.body ?? "") : Promise.resolve(body);
            fallback
              .then((text) => downloadText(safeFilename(activeDoc.title || activeDoc.id, ".md"), text, "text/markdown;charset=utf-8"))
              .catch((err) => onError(String(err.message)));
          }} />
          <MenuSep />
          <MenuItem icon="settings" label="重命名…" onClick={async () => {
            close();
            const title = await promptDialog({ title: "重命名文档", value: activeDoc.title });
            if (title) { await api.updateDocument(activeDoc.id, { title }); reloadNav(); }
          }} />
          <MenuSep />
          <MenuItem icon="trash" label="删除文档" danger onClick={async () => {
            close();
            const ok = await confirmDialog({ title: "删除文档？", message: `「${activeDoc.title || "无标题"}」将被删除。`, confirmLabel: "删除", danger: true });
            if (ok) { await api.deleteDocument(activeDoc.id); setView({ kind: "empty" }); reloadNav(); }
          }} />
        </>
      ));
    } else if (view.kind === "db" && activeDb) {
      openMenu(e, (close) => (
        <>
          <MenuItem icon="download" label="导出 CSV" onClick={() => {
            close();
            Promise.all([api.listProperties(activeDb.id), api.listRecords(activeDb.id)])
              .then(([props, records]) =>
                downloadText(safeFilename(activeDb.name || activeDb.id, ".csv"), databaseToCsv(props, records), "text/csv;charset=utf-8"),
              )
              .catch((err) => onError(String(err.message)));
          }} />
          <MenuSep />
          <MenuItem icon="settings" label="重命名…" onClick={async () => {
            close();
            const name = await promptDialog({ title: "重命名数据库", value: activeDb.name });
            if (name && name !== activeDb.name) { await api.updateDatabase(activeDb.id, { name }); reloadNav(); }
          }} />
          <MenuSep />
          <MenuItem icon="trash" label="删除数据库" danger onClick={async () => {
            close();
            const ok = await confirmDialog({ title: "删除数据库？", message: `「${activeDb.name}」及其所有记录将被永久删除。`, confirmLabel: "删除", danger: true });
            if (ok) { await api.deleteDatabase(activeDb.id); setView({ kind: "empty" }); reloadNav(); }
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
        onSearch={(q) => navigate({ kind: "search", q })}
        onCollapse={() => setSbCollapsed(true)}
        onOpenSettings={() => navigate({ kind: "settings" })}
        settingsActive={view.kind === "settings"}
        onOpenSites={() => navigate({ kind: "sites" })}
        sitesActive={view.kind === "sites"}
        updatePending={updatePending}
        reloadNav={reloadNav}
        onError={onError}
        afterDelete={(_, id) => { if ("id" in view && view.id === id) setView({ kind: "empty" }); }}
      />
      {/* mobile drawer state is applied as the `open` class on .sidebar */}
      <DrawerClass open={drawerOpen} />

      <div class="main">
        <div class={"topbar" + (view.kind === "empty" ? " bare" : "")}>
          <button
            class={"iconbtn hamburger" + (sbCollapsed ? " show-collapsed" : "")}
            title={isMobile ? "返回" : sbCollapsed ? "展开侧栏" : "菜单"}
            onClick={() =>
              isMobile
                ? navigate({ kind: "empty" })
                : sbCollapsed
                  ? setSbCollapsed(false)
                  : setDrawerOpen(true)
            }
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
              <button class="btn btn-ghost"><Icon name="share" cls="ico sm" />分享</button>
              <button class="iconbtn" onClick={moreMenu}><Icon name="dots" /></button>
            </>
          )}
        </div>

        {error && <div class="error-bar" onClick={() => setError("")}>⚠ {error}（点击关闭）</div>}

        <div class="content">
          {view.kind === "empty" && <EmptyState onNewDoc={newEmptyDoc} />}
          {view.kind === "db" && activeDb && (
            <DatabaseView key={activeDb.id} db={activeDb} reloadNav={reloadNav} onError={onError} />
          )}
          {view.kind === "doc" && (
            <DocView
              key={view.id}
              docId={view.id}
              onTitleChange={reloadNav}
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

      <div class={"backdrop" + (drawerOpen ? " show" : "")} onClick={() => setDrawerOpen(false)} />
      <UiHost />
    </>
  );
}

/** Right-pane placeholder shown when nothing is selected: a "knowledge growth"
 *  illustration (a sprout growing from a document card) that animates in, then
 *  gently sways. Pure CSS/SVG — styles live inline in src/core/sync/webui.ts. */
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

/** Toggles the mobile-drawer `open` class on the already-rendered .sidebar. */
function DrawerClass({ open }: { open: boolean }) {
  useEffect(() => {
    const sb = document.querySelector(".sidebar");
    if (sb) sb.classList.toggle("open", open);
  }, [open]);
  return null;
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
