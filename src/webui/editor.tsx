/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "./api.ts";
import { replicaActive, SYNCED_EVENT } from "./data/replica.ts";
import { Icon } from "./icons.tsx";
import { openShareModal, useSharedTargets } from "./share-modal.tsx";
import { toast } from "./ui.tsx";
import { CmDocBody, type CmHandle } from "./cm6/CmDocBody.tsx";
import { docModel } from "./cm6/doc-model.ts";
import { blockToText, type Block } from "./blocks.ts";
import { ImageLightbox } from "./media/image-lightbox.tsx";

export type DocMode = "blocks" | "source";

export interface DocViewHandle {
  getMode: () => DocMode;
  setMode: (mode: DocMode) => void;
  snapshotMarkdown: () => string;
  flushSave: () => Promise<void>;
  /** Re-fetch the document from the server (e.g. after a history revert). */
  reload: () => void;
}

export function DocView({
  docId,
  onError,
  onModeChange,
  onHandle,
}: {
  docId: string;
  onError: (m: string) => void;
  onModeChange?: (mode: DocMode) => void;
  onHandle?: (handle: DocViewHandle | null) => void;
}) {
  const sourceRef = useRef("");
  const titleRef = useRef("");
  const sharedTargets = useSharedTargets();
  const [mode, setModeState] = useState<DocMode>("blocks");
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  // ---- save pipeline state ----
  // version: the if_match token from the last read/save; dirty: unsaved local
  // edits exist; conflict: a save was rejected as stale (banner shown).
  const docVersionRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const retryDelayRef = useRef(0);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const [conflict, setConflict] = useState(false);
  // Handle to the single-document CM6 editor. Its doc IS the Markdown body, so
  // snapshot = getDoc() and remote merges push via setDoc().
  const cmRef = useRef<CmHandle | null>(null);
  const docRootRef = useRef<HTMLDivElement>(null);
  // In-page image lightbox (browser / PWA; the desktop app uses a native window).
  const [lightbox, setLightbox] = useState<{ src: string; name?: string } | null>(null);

  /** Rewrite the image void whose block.src === `token` to point at `url`
   *  (annotation write-back). CM6 block ids are ephemeral, so the src string is
   *  the routing token; the FIRST matching void wins when the same image is
   *  embedded twice. Serializes via blockToText (flush-left) and re-applies the
   *  line's leading indent so a nested image stays under its list item. */
  const replaceImageSrc = (token: string, url: string) => {
    const view = cmRef.current?.view;
    if (!view || !token || !url) return;
    for (const v of docModel(view.state).voids) {
      if (v.kind !== "image" || v.block.src !== token) continue;
      const b = structuredClone(v.block);
      b.src = url; // keep width/name
      const ws = /^[ \t]*/.exec(view.state.doc.lineAt(v.from).text)![0]!;
      let md = blockToText(b);
      if (ws) md = md.split("\n").map((l) => ws + l).join("\n");
      view.dispatch({ changes: { from: v.from, to: v.to, insert: md }, userEvent: "input.writeback" });
      return;
    }
  };

  /** Replace an image's bytes with an annotated PNG (browser lightbox path):
   *  upload the flattened blob, then point the void at the new /blob URL. */
  const replaceAnnotated = async (token: string, blob: Blob) => {
    try {
      const up = await api.uploadDocBlob(new File([blob], "annotated.png", { type: "image/png" }));
      replaceImageSrc(token, up.url);
      // Keep annotating the (now current) image: the lightbox follows the new src.
      setLightbox((lb) => (lb && lb.src === token ? { ...lb, src: up.url } : lb));
    } catch (err) {
      toast(`保存失败：${(err as Error).message}`);
    }
  };

  /** Open the image preview. Desktop app → a frameless native window (the editor
   *  gets the annotated result back over BroadcastChannel); browser → in-page
   *  lightbox overlay. */
  const openImagePreview = (b: Block) => {
    const src = b.src ?? "";
    if (typeof window !== "undefined" && window.metahubDesktop?.preview) {
      // Protocol shape unchanged from the block editor: `blockId` routes the
      // annotated replacement back. CM6 block ids are ephemeral, so pass the
      // src string as the token and match on block.src when it comes back.
      void window.metahubDesktop.preview.open({ src, name: b.name, blockId: src });
    } else {
      setLightbox({ src, name: b.name });
    }
  };

  // Receive "image replaced" from a desktop preview window (annotation flattened
  // and re-uploaded there): rewrite the matching image void in the live doc.
  useEffect(() => {
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel("mh-doc-image");
    } catch {
      return;
    }
    ch.onmessage = (e) => {
      const d = e.data as { action?: string; blockId?: string; url?: string } | null;
      if (!d || d.action !== "replace" || !d.blockId || !d.url) return;
      replaceImageSrc(d.blockId, d.url);
    };
    return () => ch?.close();
  }, []);

  const loadDoc = () => {
    setLoading(true);
    setConflict(false);
    api
      .getDocument(docId)
      .then((d) => {
        titleRef.current = d.title ?? "";
        sourceRef.current = d.body ?? "";
        docVersionRef.current = d.version ?? null;
        dirtyRef.current = false;
        setLoading(false);
        setVersion((v) => v + 1);
      })
      .catch((e) => onError(String(e.message)));
  };

  useEffect(() => {
    loadDoc();
    return () => clearTimeout(saveTimer.current);
  }, [docId]);

  // Unsaved work (debounce window, failed save being retried) shouldn't be
  // lost to a casual tab close — ask the browser to confirm.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = ""; // Chrome requires returnValue for the prompt to show
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // Remote-merge refresh (local-replica mode): a background sync that touched
  // documents/doc_blocks may have merged edits into the open doc. Flush any
  // pending keystrokes first (block-level CRDT merges them), then re-read; a
  // version match means this doc wasn't affected. Replaces the HTTP-mode
  // stale banner — there is no "conflict" to resolve, merge already happened.
  useEffect(() => {
    const onSynced = (e: Event) => {
      const detail = (e as CustomEvent).detail as { datasets?: string[] } | undefined;
      if (!detail?.datasets?.some((d) => d === "documents" || d === "doc_blocks")) return;
      void (async () => {
        try {
          if (dirtyRef.current) await flushSave();
          const d = await api.getDocument(docId);
          if (d.version != null && d.version === docVersionRef.current) return;
          // Push the merged body into the one CM document; setDoc's prefix/suffix
          // diff preserves the caret when the remote change was elsewhere.
          titleRef.current = d.title ?? "";
          sourceRef.current = d.body ?? "";
          cmRef.current?.setDoc(d.body ?? "");
          docVersionRef.current = d.version ?? null;
          dirtyRef.current = false;
          setConflict(false);
          setVersion((v) => v + 1);
          toast("已合并其他设备的修改");
        } catch {
          // Doc deleted remotely or replica hiccup — the nav refresh handles it.
        }
      })();
    };
    document.addEventListener(SYNCED_EVENT, onSynced);
    return () => document.removeEventListener(SYNCED_EVENT, onSynced);
  }, [docId]);

  const scheduleSave = () => {
    dirtyRef.current = true;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 700);
  };
  const snapshotMarkdown = () => cmRef.current?.getDoc() ?? sourceRef.current;
  // Saves are serialized through a chain so a debounced save never races a
  // flush: the later save reads the version the earlier one returned, keeping
  // if_match conflicts to *real* concurrent edits (CLI, sync, other windows).
  //
  // Local-replica path: no if_match. A single local writer can't race itself,
  // and remote edits arrive through /sync where the CRDT merges at block
  // level — the stale/conflict machinery is an HTTP-mode concept. Remote
  // changes to the open doc surface via the SYNCED_EVENT refresh above.
  const doSave = (opts: { force?: boolean } = {}) =>
    api
      .updateDocument(docId, {
        title: titleRef.current,
        body: snapshotMarkdown(),
        ...(opts.force || docVersionRef.current == null || replicaActive()
          ? {}
          : { if_match: docVersionRef.current }),
      })
      .then((d) => {
        docVersionRef.current = d.version ?? null;
        dirtyRef.current = false;
        retryDelayRef.current = 0;
        setConflict(false);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.code === "stale") {
          // Someone else changed this doc since we read it. Stop auto-saving
          // and let the user pick a side (banner below) instead of clobbering.
          setConflict(true);
          return;
        }
        // Transient failure (server restart, network blip): keep the work
        // dirty, surface the error, and retry with backoff until a save lands.
        onError(String((e as Error).message));
        retryDelayRef.current = Math.min(Math.max(retryDelayRef.current * 2, 1_000), 30_000);
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(save, retryDelayRef.current);
      });
  const save = (opts: { force?: boolean } = {}) =>
    (saveChainRef.current = saveChainRef.current.then(() => doSave(opts)));
  const flushSave = async () => {
    clearTimeout(saveTimer.current);
    await save();
  };

  const setDisplayMode = (next: DocMode) => {
    if (next === mode) return;
    // Source mode is just the rich decoration layer toggled off on the same view.
    sourceRef.current = snapshotMarkdown();
    cmRef.current?.setSource(next === "source");
    setModeState(next);
    onModeChange?.(next);
    requestAnimationFrame(() => cmRef.current?.focus());
  };

  useEffect(() => {
    onHandle?.({
      getMode: () => mode,
      setMode: setDisplayMode,
      snapshotMarkdown,
      flushSave,
      reload: loadDoc,
    });
    return () => onHandle?.(null);
  }, [onHandle, mode]);

  // Focus the document title (the contentEditable above the body), caret at end.
  const focusTitle = () => {
    const el = document.querySelector(".doc-title") as HTMLElement | null;
    if (!el) return;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false); // caret to the end of the title
    const s = getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  };

  if (loading) return <div class="empty">加载中…</div>;

  // Move the caret to the very start of the body and focus it (title → body).
  const enterBody = () => {
    cmRef.current?.view?.dispatch({ selection: { anchor: 0 } });
    cmRef.current?.focus();
  };
  return (
    <div ref={docRootRef} class={"doc" + (mode === "source" ? " source-mode" : "")}>
      {conflict && (
        <div class="doc-conflict" role="alert">
          <span class="doc-conflict-msg">文档已被其他端修改，自动保存已暂停。</span>
          <button class="btn btn-secondary" onClick={() => loadDoc()}>
            载入最新（弃本地改动）
          </button>
          <button class="btn btn-danger" onClick={() => void save({ force: true })}>
            用本地版本覆盖
          </button>
        </div>
      )}
      <div
        class="doc-title"
        contentEditable
        onInput={(e) => { titleRef.current = (e.target as HTMLElement).textContent ?? ""; scheduleSave(); }}
        onKeyDown={(e) => {
          if (e.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") { e.preventDefault(); enterBody(); return; }
          if (e.key === "ArrowDown" && caretLineEdge(e.currentTarget as HTMLElement).last) { e.preventDefault(); enterBody(); }
        }}
        dangerouslySetInnerHTML={{ __html: titleRef.current }}
      />
      <div class="doc-meta">
        <span>实时同步</span>
        {sharedTargets.has(docId) && (
          <button
            class="doc-shared"
            title="已分享 · 管理分享"
            onClick={() => openShareModal({ kind: "doc", ref: docId, title: titleRef.current })}
          >
            <Icon name="link" cls="ico sm" />已分享
          </button>
        )}
      </div>
      {!loading && (
        <CmDocBody
          key={docId}
          initialDoc={sourceRef.current}
          source={mode === "source"}
          onChange={scheduleSave}
          onReady={(h) => { cmRef.current = h; }}
          onExitTop={focusTitle}
          onError={onError}
          onPreviewImage={openImagePreview}
        />
      )}
      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          name={lightbox.name}
          onClose={() => setLightbox(null)}
          onReplace={(blob) => void replaceAnnotated(lightbox.src, blob)}
        />
      )}
    </div>
  );
}

// Is the collapsed caret on the first / last visual line of `el`? Compares the
// caret's rect against the element's box within half a line-height of tolerance.
// An empty element (no caret rect) counts as both first and last.
function caretLineEdge(el: HTMLElement): { first: boolean; last: boolean } {
  const sel = getSelection();
  if (!sel || !sel.rangeCount) return { first: true, last: true };
  const cr = sel.getRangeAt(0).getBoundingClientRect();
  const er = el.getBoundingClientRect();
  if (!cr.height && !cr.top) return { first: true, last: true };
  const lh = parseFloat(getComputedStyle(el).lineHeight) || cr.height || 20;
  return { first: cr.top - er.top < lh * 0.5, last: er.bottom - cr.bottom < lh * 0.5 };
}
