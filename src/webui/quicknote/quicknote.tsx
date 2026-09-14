/** @jsxImportSource preact */
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, NAV_INVALIDATE, type DocSummary } from "../api.ts";
import { Icon } from "../icons.tsx";
import { DocView, type DocViewHandle } from "../editor.tsx";
import { pressed, tip } from "../shortcuts.ts";
import { viewToHash } from "../view.ts";
import {
  UiHost,
  openMenu,
  MenuItem,
  MenuLabel,
  MenuSep,
  confirmDialog,
} from "../ui.tsx";

// The Quick Notes window: a single-page Preact view rendered from the same
// webui bundle as the main app, but mounted only on the desktop when the URL
// hash is `#quick` (see app.tsx). Every note is a plain document parented under
// a special "Quick Notes" doc, so notes show up in the main app too and
// replicate over /sync. The editor is the shared block DocView — no separate
// markdown editor. The "which doc is the container" concept lives entirely here
// (localStorage + title discovery); core knows nothing about quick notes.

const LAST_KEY = "mh-quicknote-last";
const PARENT_KEY = "mh-quicknote-parent";
const PARENT_TITLE = "Quick Notes";

/** Sort newest-first by HLC so the list and default-open match expectations. */
function newestFirst(a: DocSummary, b: DocSummary): number {
  return (b.created_hlc ?? "").localeCompare(a.created_hlc ?? "");
}

/**
 * Resolve the special "Quick Notes" parent document id, creating it once if
 * needed. Cached locally; if a peer already replicated a top-level "Quick
 * Notes" doc, adopt it instead of creating a duplicate. Purely client-side —
 * the server only sees generic document calls.
 */
async function resolveQuickNotesParent(): Promise<string> {
  const cached = localStorage.getItem(PARENT_KEY);
  if (cached) {
    try {
      await api.getDocument(cached);
      return cached;
    } catch {
      // deleted — fall through and re-resolve
    }
  }
  const all = await api.listDocuments();
  const existing = all.find((d) => d.parent_id == null && d.title === PARENT_TITLE);
  const id = existing?.id ?? (await api.createDocument({ title: PARENT_TITLE })).id;
  localStorage.setItem(PARENT_KEY, id);
  return id;
}

export function QuickNote() {
  const [parentId, setParentId] = useState<string | null>(null);
  const [notes, setNotes] = useState<DocSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pinned, setPinned] = useState(false);
  const docHandleRef = useRef<DocViewHandle | null>(null);

  const qn = typeof window !== "undefined" ? window.metahubDesktop?.quicknote : undefined;

  const reload = useCallback(async (pid: string): Promise<DocSummary[]> => {
    const list = (await api.listDocumentsByParent(pid)).sort(newestFirst);
    setNotes(list);
    return list;
  }, []);

  // Saves inside DocView (title edits included) dispatch NAV_INVALIDATE from
  // api.ts — refresh the note list from the same signal the main app uses.
  useEffect(() => {
    if (!parentId) return;
    let timer: ReturnType<typeof setTimeout>;
    const on = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void reload(parentId), 80);
    };
    document.addEventListener(NAV_INVALIDATE, on);
    return () => {
      clearTimeout(timer);
      document.removeEventListener(NAV_INVALIDATE, on);
    };
  }, [parentId, reload]);

  const createNote = useCallback(
    async (pid: string): Promise<string> => {
      const doc = await api.createDocument({ title: "", parent_id: pid });
      await reload(pid);
      return doc.id;
    },
    [reload],
  );

  // Initial load: resolve parent, list notes, open last-opened or newest, else
  // create a fresh blank note so the window is never empty.
  useEffect(() => {
    (async () => {
      try {
        const id = await resolveQuickNotesParent();
        setParentId(id);
        const list = await reload(id);
        const last = localStorage.getItem(LAST_KEY);
        const open =
          (last && list.some((n) => n.id === last) && last) ||
          list[0]?.id ||
          (await createNote(id));
        setActiveId(open);
      } catch (e) {
        setError(String((e as Error).message));
      }
    })();
  }, [reload, createNote]);

  // Remember the last-opened note for next launch.
  useEffect(() => {
    if (activeId) localStorage.setItem(LAST_KEY, activeId);
  }, [activeId]);

  // Reflect the persisted always-on-top state on the pin button.
  useEffect(() => {
    qn?.getAlwaysOnTop().then(setPinned).catch(() => {});
  }, [qn]);

  const newNote = async () => {
    if (!parentId) return;
    try {
      setActiveId(await createNote(parentId));
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const openInMain = () => {
    if (!activeId) return;
    try {
      const ch = new BroadcastChannel("mh-open-doc");
      ch.postMessage({ id: activeId });
      ch.close();
    } catch {
      /* no BroadcastChannel — openMain's hash path still covers it */
    }
    const d = window.metahubDesktop;
    if (d?.quicknote?.openMain) void d.quicknote.openMain(viewToHash({ kind: "doc", id: activeId }));
    else void d?.file?.focusMain();
    void qn?.hide();
  };

  // Window-level shortcuts; bindings live in shortcuts.ts.
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keysRef.current = (e) => {
    if (pressed(e, "qnHide")) {
      void qn?.hide();
      return;
    }
    if (pressed(e, "qnNew")) {
      e.preventDefault();
      void newNote();
      return;
    }
    if (pressed(e, "qnOpenMain")) {
      e.preventDefault();
      openInMain();
      return;
    }
    const step = pressed(e, "qnPrev") ? -1 : pressed(e, "qnNext") ? 1 : 0;
    if (step) {
      e.preventDefault();
      const i = notes.findIndex((n) => n.id === activeId);
      const next = notes[i + step];
      if (i >= 0 && next) setActiveId(next.id);
    }
  };
  useEffect(() => {
    if (!qn) return;
    const on = (e: KeyboardEvent) => keysRef.current(e);
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [qn]);

  const togglePin = async () => {
    if (!qn) return;
    const next = !pinned;
    setPinned(next);
    try {
      setPinned(await qn.setAlwaysOnTop(next));
    } catch {
      setPinned(!next);
    }
  };

  const deleteActive = async () => {
    if (!activeId || !parentId) return;
    const ok = await confirmDialog({
      title: "删除笔记？",
      message: "该快速笔记将被删除。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    await api.deleteDocument(activeId);
    const list = await reload(parentId);
    setActiveId(list[0]?.id ?? (await createNote(parentId)));
  };

  const openList = (e: MouseEvent) => {
    openMenu(
      e,
      (close) => (
        <>
          <MenuLabel>快速笔记</MenuLabel>
          {notes.length === 0 && <div class="lbl">还没有笔记</div>}
          {notes.map((n) => (
            <MenuItem
              key={n.id}
              icon="file"
              label={n.title || "无标题"}
              checked={n.id === activeId}
              onClick={() => {
                close();
                setActiveId(n.id);
              }}
            />
          ))}
          <MenuSep />
          <MenuItem
            icon="plus"
            label="新建笔记"
            shortcut="qnNew"
            onClick={() => {
              close();
              void newNote();
            }}
          />
          {activeId && (
            <MenuItem
              icon="externalLink"
              label="在主窗口中打开"
              shortcut="qnOpenMain"
              onClick={() => {
                close();
                openInMain();
              }}
            />
          )}
          {activeId && (
            <MenuItem
              icon="trash"
              label="删除当前笔记"
              danger
              onClick={() => {
                close();
                void deleteActive();
              }}
            />
          )}
        </>
      ),
      { minWidth: 220 },
    );
  };

  const activeTitle = notes.find((n) => n.id === activeId)?.title;

  return (
    <div class="qn">
      <div class="qn-bar">
        <span class="qn-brand">{activeTitle || "快速笔记"}</span>
        <div class="qn-actions">
          <button class="iconbtn" {...tip("新建笔记", "qnNew")} onClick={() => void newNote()}>
            <Icon name="plus" />
          </button>
          <button class="iconbtn" {...tip("笔记列表")} onClick={openList}>
            <Icon name="list" />
          </button>
          {qn && (
            <button
              class={"iconbtn" + (pinned ? " active" : "")}
              {...tip(pinned ? "取消置顶" : "始终置顶")}
              onClick={() => void togglePin()}
            >
              <Icon name="pin" />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div class="error-bar" onClick={() => setError("")}>
          ⚠ {error}（点击关闭）
        </div>
      )}

      <div class="qn-body">
        {activeId ? (
          <DocView
            key={activeId}
            docId={activeId}
            autoTitle
            onError={setError}
            onHandle={(h) => (docHandleRef.current = h)}
          />
        ) : (
          <div class="empty">
            <div>加载中…</div>
          </div>
        )}
      </div>

      <UiHost />
    </div>
  );
}
