/** @jsxImportSource preact */
// The desktop file-editor window (loaded at `…/#file?path=…`): Metahub as an
// "open with" handler for .txt/.md. A standalone CM6 editor over the on-disk
// file — no doc record, no server persistence: the file text goes straight into
// CmDocBody and Cmd+S writes handle.getDoc() back to disk over the preload
// `file` bridge (path-allowlisted in the Electron main process). The 导入到
// MetaHub button snapshots the current text into a new top-level document via
// the ordinary api.createDocument, then can raise the main window and deep-link
// it to the new doc over BroadcastChannel("mh-open-doc") (listener in app.tsx).
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import { CmDocBody, type CmHandle } from "../cm6/CmDocBody.tsx";
import { UiHost, toast } from "../ui.tsx";

function parseHash(): { path: string } {
  const h = typeof location !== "undefined" ? location.hash : "";
  const q = h.includes("?") ? h.slice(h.indexOf("?") + 1) : "";
  return { path: new URLSearchParams(q).get("path") || "" };
}

const stripExt = (name: string) => name.replace(/\.(md|markdown|txt)$/i, "");

export function FileEditorWindow() {
  const fs = typeof window !== "undefined" ? window.metahubDesktop?.file : undefined;
  // Preload-read initial content (--mh-open-file + sync IPC): present, the very
  // first render already shows the text — no 加载中 flash, and no dependence on
  // URL parsing (the disk-loaded standalone shell carries no #file hash).
  const initial = fs?.initial ?? null;
  const [{ path }] = useState(() => (initial ? { path: initial.path } : parseHash()));
  const [name, setName] = useState(initial?.name ?? "");
  const [text, setText] = useState<string | null>(initial?.text ?? null);
  const [dirty, setDirty] = useState(false);
  // .txt opens in source mode (plain text, no WYSIWYG surprises); .md rich.
  const [source, setSource] = useState(() => /\.txt$/i.test(path));
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importedId, setImportedId] = useState<string | null>(null);
  // Import success disables the button until the content changes again, so a
  // double-click can't mint duplicate documents.
  const [importedFresh, setImportedFresh] = useState(false);
  const handleRef = useRef<CmHandle | null>(null);

  const save = async (): Promise<{ ok: boolean; error?: string }> => {
    const h = handleRef.current;
    if (!h || !fs) return { ok: false, error: "编辑器尚未就绪" };
    try {
      await fs.write(path, h.getDoc());
      setDirty(false);
      return { ok: true };
    } catch (e) {
      const msg = String((e as Error).message);
      setError(msg);
      return { ok: false, error: msg };
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // Load the file once (skipped when preload already delivered it). The window
  // only exists on desktop with a path (main.ts controls the URL/args), but
  // guard anyway for a stray browser hit.
  useEffect(() => {
    if (initial) {
      document.title = initial.name;
      return;
    }
    if (!fs || !path) {
      setError(fs ? "缺少文件路径" : "文件编辑窗口仅在桌面应用内可用");
      return;
    }
    fs.read(path)
      .then((r) => {
        setName(r.name);
        setText(r.text);
        // The shared HTML shell's <title> overrides the BrowserWindow title —
        // put the filename back.
        document.title = r.name;
      })
      .catch((e) => setError(String((e as Error).message)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cmd/Ctrl+S saves back to disk (CM6 binds no Mod-S of its own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  // Close-confirm 保存 path: main asks us to write, saveDone reports back.
  // Main rechecks its own dirty flag before closing — a failed write keeps the
  // window (and the edits) alive; the result here only feeds its error dialog.
  useEffect(() => {
    if (!fs?.onRequestSave) return;
    return fs.onRequestSave(() => {
      void (async () => {
        const r = await saveRef.current();
        await fs.saveDone(r);
      })();
    });
  }, [fs]);

  const onChange = () => {
    setImportedFresh(false);
    setDirty((was) => {
      // Dirty also lives in the main process: it drives the macOS close-button
      // dot and gates the native unsaved-changes confirm.
      if (!was) void fs?.setDirty(path, true);
      return true;
    });
  };

  const toggleSource = () => {
    const next = !source;
    setSource(next);
    handleRef.current?.setSource(next);
  };

  const doImport = async () => {
    const h = handleRef.current;
    if (!h) return;
    setImporting(true);
    try {
      const doc = await api.createDocument({ title: stripExt(name), body: h.getDoc() });
      setImportedId(doc.id);
      setImportedFresh(true);
      toast("已导入到 MetaHub");
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setImporting(false);
    }
  };

  const openInMain = () => {
    if (!importedId) return;
    // BroadcastChannel is same-origin only — it reaches the main window when
    // this window is served by the sidecar (#file route) but NOT from the
    // disk-loaded file:// shell. The doc id therefore also rides the focusMain
    // IPC, which the main process forwards as mh:open-doc (app.tsx listens to
    // both; the double delivery is idempotent — same navigate target).
    try {
      const ch = new BroadcastChannel("mh-open-doc");
      ch.postMessage({ id: importedId });
      ch.close();
    } catch {
      /* no BroadcastChannel — the main window still comes to front */
    }
    void fs?.focusMain(importedId);
  };

  return (
    <div class="fw">
      <div class="fw-bar">
        <span class="fw-name" title={path}>
          {name || path}
          {dirty && <span class="fw-dirty"> •</span>}
        </span>
        <div class="fw-actions">
          <button class="btn btn-ghost" onClick={toggleSource}>
            {source ? "预览模式" : "源码模式"}
          </button>
          {importedId && (
            <button class="btn btn-secondary" onClick={openInMain}>
              在 MetaHub 中打开
            </button>
          )}
          <button
            class="btn btn-primary"
            disabled={importing || importedFresh || text === null}
            onClick={() => void doImport()}
          >
            {importedFresh ? "已导入 ✓" : importing ? "导入中…" : "导入到 MetaHub"}
          </button>
        </div>
      </div>

      {error && (
        <div class="error-bar" onClick={() => setError("")}>
          ⚠ {error}（点击关闭）
        </div>
      )}

      <div class="fw-body">
        {text !== null ? (
          <div class="doc">
            <CmDocBody
              initialDoc={text}
              source={source}
              disableUploads
              onChange={onChange}
              onReady={(h) => (handleRef.current = h)}
              onError={setError}
            />
          </div>
        ) : (
          !error && (
            <div class="empty">
              <div>加载中…</div>
            </div>
          )
        )}
      </div>

      <UiHost />
    </div>
  );
}
