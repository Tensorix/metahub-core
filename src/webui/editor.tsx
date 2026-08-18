/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "./api.ts";
import { clientMode, onReplicaStatus, replicaActive, replicaStatus, SYNCED_EVENT } from "./data/replica.ts";
import type { ReplicaStatus } from "./data/db-worker.ts";
import { sameDay } from "./date.ts";
import { Icon } from "./icons.tsx";
import { openShareModal, useSharedTargets } from "./share-modal.tsx";
import { toast } from "./ui.tsx";
import { CmDocBody, type CmHandle } from "./cm6/CmDocBody.tsx";
import { handleClickBelow } from "./cm6/click-below.ts";
import { docModel } from "./cm6/doc-model.ts";
import { enterDocTop, splitDocTop } from "./cm6/structure.ts";
import { mediaFilesFrom, uploadFilesAt } from "./cm6/chrome/upload-paste.tsx";
import { openDocFind } from "./cm6/chrome/find.tsx";
import { previewAnchor, setPreviewAnchor } from "./cm6/chrome/preview-anchor.ts";
import { blockToText, type Block } from "./blocks.ts";
import { deletePlainSelection, flattenToText, insertPlainText, plainPasteHandlers } from "./plain-edit.ts";
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
  wide,
  onError,
  onModeChange,
  onHandle,
}: {
  docId: string;
  wide?: boolean;
  onError: (m: string) => void;
  onModeChange?: (mode: DocMode) => void;
  onHandle?: (handle: DocViewHandle | null) => void;
}) {
  const sourceRef = useRef("");
  const titleRef = useRef("");
  const titleElRef = useRef<HTMLDivElement | null>(null);
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

  /** Rewrite the image void the user opened in the preview to point at `url`
   *  (annotation write-back). CM6 block ids are ephemeral, so the src string is
   *  the routing token — ambiguous when the same image is embedded twice. The
   *  previewAnchor field remembers the OPENED void's position (remapped through
   *  edits), so among same-src candidates the one nearest the anchor wins; the
   *  src match remains the correctness gate. Serializes via blockToText
   *  (flush-left) and re-applies the line's leading indent so a nested image
   *  stays under its list item. */
  const replaceImageSrc = (token: string, url: string) => {
    const view = cmRef.current?.view;
    if (!view || !token || !url) return;
    const candidates = docModel(view.state).voids.filter(
      (v) => v.kind === "image" && v.block.src === token,
    );
    if (!candidates.length) return;
    const anchor = previewAnchor(view.state);
    const v = anchor && anchor.token === token
      ? candidates.reduce((a, b) => (Math.abs(a.from - anchor.pos) <= Math.abs(b.from - anchor.pos) ? a : b))
      : candidates[0]!;
    const b = structuredClone(v.block);
    b.src = url; // keep width/name
    const ws = /^[ \t]*/.exec(view.state.doc.lineAt(v.from).text)![0]!;
    let md = blockToText(b);
    if (ws) md = md.split("\n").map((l) => ws + l).join("\n");
    view.dispatch({ changes: { from: v.from, to: v.to, insert: md }, userEvent: "input.writeback" });
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
    // Pin WHICH embed was opened (block identity first, src as fallback) so the
    // annotated result routes back to this one even with duplicate embeds.
    const view = cmRef.current?.view;
    if (view) {
      const voids = docModel(view.state).voids;
      const opened = voids.find((v) => v.block === b) ?? voids.find((v) => v.kind === "image" && v.block.src === src);
      if (opened) view.dispatch({ effects: setPreviewAnchor.of({ token: src, pos: opened.from }) });
    }
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

  // Seed the contentEditable title from the ref on every load / remote-merge
  // (both bump `version`). Writing textContent keeps the title uncontrolled —
  // no innerHTML, no framework-managed children — so a synced title can never
  // inject HTML (stored XSS) and typing never triggers a caret-resetting render.
  // The `firstElementChild` arm also clears any markup that slipped in: after a
  // rich paste the text matches but the DOM still carries the styled spans, so
  // a textContent-only comparison would never reseed.
  useEffect(() => {
    const el = titleElRef.current;
    if (el && (el.textContent !== titleRef.current || el.firstElementChild)) el.textContent = titleRef.current;
  }, [version]);

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

  // Window-level Cmd/Ctrl+F fallback: CM's own Mod-f binding only fires while
  // contentDOM has focus. With focus in the title, a code-island textarea, a
  // table cell, or nowhere, the browser's native find would run instead — and it
  // cannot search CM's unrendered (viewport-virtualized) lines. When CM handled
  // the key its keymap preventDefaulted, so the defaultPrevented check keeps the
  // two paths from double-firing. Modals own the keyboard while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "f") return;
      if (e.defaultPrevented) return;
      if (document.querySelector(".lightbox, .modal-scrim.open")) return;
      const v = cmRef.current?.view;
      if (!v || !v.dom.isConnected) return;
      e.preventDefault();
      openDocFind(v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus the document title (the contentEditable above the body). Caret at the
  // end by default, or at `offset` characters in (the merge seam below). Goes
  // through titleElRef, never a global `.doc-title` lookup: quicknote embeds a
  // second DocView, and a document-wide selector would grab whichever came first.
  const focusTitle = (offset?: number) => {
    const el = titleElRef.current;
    if (!el) return;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false); // caret to the end of the title
    const node = el.firstChild;
    if (offset != null && node?.nodeType === Node.TEXT_NODE) {
      r.setStart(node, Math.min(offset, node.textContent?.length ?? 0));
      r.collapse(true);
    }
    const s = getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  };

  // Backspace at the very start of the body: the title is the block above, so the
  // first line merges into it — its text lands at the title's end and the caret
  // parks at the seam. insertPlainText (execCommand) is the one insertion that
  // joins the contentEditable's native undo stack, so the merge stays undoable on
  // the title side. False = no title mounted, CM keeps the key.
  const mergeIntoTitle = (text: string): boolean => {
    const el = titleElRef.current;
    if (!el) return false;
    const seam = (el.textContent ?? "").length;
    focusTitle(); // caret at the end, where the merged text goes
    if (text) insertPlainText(text); // fires onInput (flatten + titleRef + save)
    focusTitle(seam);
    titleRef.current = el.textContent ?? ""; // the Range fallback emits no input
    scheduleSave();
    return true;
  };

  // Enter in the title: the title is the body's line above, so Enter breaks at
  // the seam — everything right of the caret is CUT from the title and becomes
  // the document's new first block, caret at its start. Exact inverse of
  // mergeIntoTitle, so the two round-trip across the seam. Both ranges are built
  // from the live selection (no character-offset math, so no assumption about
  // the title's node structure); starting the cut at the selection's START and
  // the moved text at its END means a non-collapsed selection is swallowed by
  // the same cut, as Enter does anywhere else.
  const splitTitleIntoBody = () => {
    const el = titleElRef.current;
    const v = cmRef.current?.view;
    if (!el || !v) return;
    const sel = getSelection();
    const live = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    let moved = "";
    if (sel && live && el.contains(live.commonAncestorContainer)) {
      const after = document.createRange();
      after.setStart(live.endContainer, live.endOffset);
      after.setEnd(el, el.childNodes.length);
      moved = after.toString();
      const cut = document.createRange();
      cut.setStart(live.startContainer, live.startOffset);
      cut.setEnd(el, el.childNodes.length);
      // Not `cut.collapsed`: with the caret at the title's end the range spans
      // (textNode, len) → (el, childCount) — distinct boundary nodes, so
      // `collapsed` is false even though the range holds nothing, and the
      // delete below would backspace the title's last character.
      if (cut.toString() !== "") {
        sel.removeAllRanges();
        sel.addRange(cut);
        deletePlainSelection(); // execCommand: joins the title's native undo stack
        titleRef.current = el.textContent ?? ""; // the Range fallback emits no input
        scheduleSave();
      }
    }
    splitDocTop(v, moved);
  };

  if (loading) return <div class="empty">加载中…</div>;

  // Move the caret to the very start of the body and focus it (title → body).
  // enterDocTop opens a fresh line first when the doc starts with a void, so the
  // caret never lands editable on a fence/table/media source line.
  const enterBody = () => {
    const v = cmRef.current?.view;
    if (v) enterDocTop(v);
  };
  return (
    <div
      ref={docRootRef}
      class={"doc" + (mode === "source" ? " source-mode" : "") + (wide ? " wide-mode" : "")}
      // Clicking the column's empty bottom padding (below the editor) drops the
      // caret on a trailing empty paragraph — see cm6/click-below.ts. Handler
      // lives on the .doc column (not document) so other UI is untouched.
      onMouseDown={(e) => {
        const v = cmRef.current?.view;
        if (v) handleClickBelow(v, e);
      }}
      // File-drop safety net for everywhere CM's own drop handler doesn't cover
      // (title, meta row, the empty padding below a short document): without a
      // dragover preventDefault the browser NAVIGATES to the dropped file,
      // tearing down the editor and any edits in the save-debounce window. Drops
      // CM already handled arrive here with defaultPrevented set — skip those.
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        if (e.defaultPrevented) return; // CM's drop handler already took it
        const v = cmRef.current?.view;
        const files = mediaFilesFrom(e.dataTransfer);
        if (!v || !files.length) return;
        e.preventDefault();
        uploadFilesAt(v, v.state.doc.length, files, onError); // append at doc end
      }}
    >
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
        ref={titleElRef}
        {...plainPasteHandlers()}
        onInput={(e) => {
          const el = e.target as HTMLElement;
          // Safety net for injection paths the paste/drop handlers don't see
          // (spellcheck replacement, extensions, autofill): the title is a
          // plain string, so nested markup only ever hijacks its font size.
          // Never during composition — flattening would break IME input.
          if (!e.isComposing) flattenToText(el);
          titleRef.current = el.textContent ?? "";
          scheduleSave();
        }}
        onKeyDown={(e) => {
          if (e.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") { e.preventDefault(); splitTitleIntoBody(); return; }
          if (e.key === "ArrowDown" && caretLineEdge(e.currentTarget as HTMLElement).last) { e.preventDefault(); enterBody(); }
        }}
      />
      <div class="doc-meta">
        <SyncStamp />
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
          onExitTop={() => focusTitle()}
          onMergeTop={mergeIntoTitle}
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

// doc-meta sync stamp: the last successful sync time for this client's data
// home. Replica clients (browser local-first / no-origin) read the worker's
// push status; window clients (desktop sidecar, browser over a server) show
// the server's own peer/bucket sync times. With no sync source configured we
// keep the old "实时同步" label — accurate for a plain server window.
function SyncStamp() {
  const [st, setSt] = useState<{ at: number | null; error: string | null }>({ at: null, error: null });
  const [, setTick] = useState(0); // re-render so the relative label keeps walking
  useEffect(() => {
    const tick = setInterval(() => setTick((n) => n + 1), 30_000);
    const offs: Array<() => void> = [() => clearInterval(tick)];
    if (clientMode().hold === "replica") {
      const apply = (s: ReplicaStatus) => {
        const ls = s.lastSync;
        if (!ls) return;
        setSt(ls.ok ? { at: ls.at, error: null } : { at: null, error: ls.error ?? "未知错误" });
      };
      apply(replicaStatus());
      offs.push(onReplicaStatus(apply));
    } else {
      let dead = false;
      const pull = async () => {
        const [peers, s3] = await Promise.all([
          api.listPeers().catch(() => []),
          api.listServerS3Peers().catch(() => []),
        ]);
        if (dead) return;
        const at = Math.max(
          0,
          ...peers.filter((p) => p.enabled).map((p) => p.last_success_at ?? 0),
          ...s3.filter((p) => p.enabled).map((p) => p.lastSyncAt ?? 0),
        );
        if (at) setSt({ at, error: null });
      };
      void pull();
      const poll = setInterval(() => void pull(), 60_000);
      offs.push(() => { dead = true; clearInterval(poll); });
    }
    return () => offs.forEach((f) => f());
  }, []);
  if (st.error) return <span title={st.error}>同步失败</span>;
  if (st.at) return <span title={new Date(st.at).toLocaleString()}>上次同步 {fmtSyncStamp(st.at)}</span>;
  return <span>实时同步</span>;
}

// Absolute clock time, not "n minutes ago": auto-sync runs every ~30s, so a
// relative label would sit on "刚刚" forever and carry no information. A time
// that visibly ticks with each sync round does; older stamps gain the date.
function fmtSyncStamp(at: number): string {
  const d = new Date(at);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay(d, new Date()) ? hm : `${d.toLocaleDateString()} ${hm}`;
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
