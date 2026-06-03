/** @jsxImportSource preact */
import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, type Db, type DocSummary, type Hit } from "./api.ts";
import { Icon } from "./icons.tsx";
import { Sidebar } from "./sidebar.tsx";
import { DatabaseView } from "./table.tsx";
import { DocView, type DocMode, type DocViewHandle } from "./editor.tsx";
import { SettingsView } from "./settings.tsx";
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
  | { kind: "settings" };

function App() {
  const [databases, setDatabases] = useState<Db[]>([]);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [view, setView] = useState<View>({ kind: "empty" });
  const [error, setError] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sbCollapsed, setSbCollapsed] = useState(false);
  const [sbWidth, setSbWidth] = useState(268);
  const [docMode, setDocMode] = useState<DocMode>("blocks");
  const docHandleRef = useRef<DocViewHandle | null>(null);

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

  const navigate = (v: View) => {
    setView(v);
    setDrawerOpen(false);
  };

  const activeDb = view.kind === "db" ? databases.find((d) => d.id === view.id) : undefined;
  const activeDoc = view.kind === "doc" ? docs.find((d) => d.id === view.id) : undefined;
  const activeDocId = view.kind === "doc" ? view.id : null;

  useEffect(() => {
    setDocMode("blocks");
  }, [activeDocId]);

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
        reloadNav={reloadNav}
        onError={onError}
        afterDelete={(_, id) => { if ("id" in view && view.id === id) setView({ kind: "empty" }); }}
      />
      {/* mobile drawer state is applied as the `open` class on .sidebar */}
      <DrawerClass open={drawerOpen} />

      <div class="main">
        <div class="topbar">
          <button
            class={"iconbtn hamburger" + (sbCollapsed ? " show-collapsed" : "")}
            title={sbCollapsed ? "展开侧栏" : "菜单"}
            onClick={() => (sbCollapsed ? setSbCollapsed(false) : setDrawerOpen(true))}
          >
            <Icon name="panelLeft" />
          </button>
          <div class="crumb">
            {view.kind === "doc" && <><span class="emoji"><Icon name="file" cls="ico sm" /></span><span>{activeDoc?.title || "无标题"}</span></>}
            {view.kind === "db" && <><span class="emoji">{activeDb?.icon || "🗂️"}</span><span>{activeDb?.name}</span></>}
            {view.kind === "search" && <span>搜索：“{view.q}”</span>}
            {view.kind === "settings" && <><span class="emoji"><Icon name="settings" cls="ico sm" /></span><span>设置</span></>}
            {view.kind === "empty" && <span class="sub">未选择任何内容</span>}
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
          {view.kind === "empty" && (
            <div class="empty">
              <div>
                <p>从左侧选择一个数据库或文档，</p>
                <p>或新建一个开始。</p>
              </div>
            </div>
          )}
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
          {view.kind === "settings" && <SettingsView />}
        </div>
      </div>

      <div class={"backdrop" + (drawerOpen ? " show" : "")} onClick={() => setDrawerOpen(false)} />
      <UiHost />
    </>
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

// The desktop Quick Notes window loads this same bundle at `…/#quick`. Mount the
// compact note view there — but only inside the desktop shell (guarded on the
// preload bridge), so a browser hitting `/#quick` just gets the full app.
if (location.hash === "#quick" && typeof window !== "undefined" && window.metahubDesktop) {
  document.body.classList.add("quicknote");
  render(<QuickNote />, document.getElementById("app")!);
} else {
  render(<App />, document.getElementById("app")!);
}
