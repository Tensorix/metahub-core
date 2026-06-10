/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "./api.ts";
import { Icon } from "./icons.tsx";
import { openMenu, MenuItem, MenuLabel, MenuSep, promptDialog } from "./ui.tsx";
import hljs from "highlight.js/lib/common";
import { htmlToMarkdown } from "./html-md.ts";
import {
  type Block,
  type BlockDraft,
  type BlockType,
  type ColAlign,
  BLOCK_MENU,
  COMMON_LANGS,
  applyBlockDraft,
  blocksFromBody,
  bodyFromBlocks,
  bulletTodoShortcut,
  computeListNumbers,
  isBlankSpacer,
  isListType,
  makeBlock,
  shortcutFromInput,
} from "./blocks.ts";
import {
  blockRangeIds,
  cloneBlock,
  countBlocks,
  deleteBlocks,
  duplicateBlocks,
  findBlock,
  flattenBlocks,
  indentBlock,
  indentBlocks,
  moveBlock,
  moveBlocks,
  nextBlock,
  outdentBlock,
  outdentBlocks,
  previousBlock,
  removeBlockById,
  serializeBlocks,
} from "./editor-ops.ts";
import { escapeHtml, inlineToHtml, htmlToInline } from "./markdown.tsx";
import { startColumnResize, markDropHalf, clearDropMarks } from "./pointer-drag.ts";

export type DocMode = "blocks" | "source";

export interface DocViewHandle {
  getMode: () => DocMode;
  setMode: (mode: DocMode) => void;
  snapshotMarkdown: () => string;
  flushSave: () => Promise<void>;
}

/** Highlight code to HTML for the overlay layer. Falls back to escaped text. */
function highlightCode(code: string, lang?: string): string {
  let html: string;
  try {
    html = lang && hljs.getLanguage(lang)
      ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      : hljs.highlightAuto(code).value;
  } catch {
    html = escapeHtml(code);
  }
  // Trailing newline collapses in the highlight <pre>; pad so its height keeps
  // pace with the textarea's caret line.
  return code.endsWith("\n") ? html + "\n" : html;
}

/** Strip inline markdown markers so a heading reads as plain text in the TOC. */
function stripInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(\*|_)([^*_]+)\1/g, "$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

/** Floating table-of-contents for the document's h1/h2/h3 blocks.
 *  Collapsed to a column of indented tick marks in the right gutter; expands to
 *  a labelled list on hover (CSS). Click jumps to the heading; a scroll-spy keeps
 *  the current section highlighted. Re-rendered with DocView's `version` bump via
 *  its `key`, so edits to headings flow through automatically. */
function DocToc({ blocks }: { blocks: Block[] }) {
  const headings = flattenBlocks(blocks)
    .filter((b) => b.type === "h1" || b.type === "h2" || b.type === "h3")
    .map((b) => ({ id: b.id, level: Number(b.type.slice(1)), text: stripInline(b.content) || "无标题" }));
  const [activeId, setActiveId] = useState<string | null>(null);
  const ids = headings.map((h) => h.id).join("|");

  useEffect(() => {
    if (!headings.length) return;
    const scroller = document.querySelector(".content");
    let raf = 0;
    // Active = the last heading whose top has scrolled above a line just below
    // the topbar. Reading rects on each cross/scroll is cheap for a handful of
    // headings and avoids guessing from intersection ratios alone.
    const compute = () => {
      const line = (scroller ? scroller.getBoundingClientRect().top : 0) + 100;
      let active = headings[0]!.id;
      for (const h of headings) {
        const el = document.querySelector(`.block[data-bid="${h.id}"]`);
        if (!el) continue;
        if (el.getBoundingClientRect().top - line <= 1) active = h.id;
        else break;
      }
      setActiveId(active);
    };
    const onScroll = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; compute(); }); };
    compute();
    const obs = new IntersectionObserver(compute, {
      root: scroller as Element | null,
      rootMargin: "-90px 0px -70% 0px",
      threshold: [0, 1],
    });
    for (const h of headings) {
      const el = document.querySelector(`.block[data-bid="${h.id}"]`);
      if (el) obs.observe(el);
    }
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      obs.disconnect();
      scroller?.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ids]);

  if (!headings.length) return null;

  const jump = (id: string) => {
    document.querySelector(`.block[data-bid="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <nav class="doc-toc" aria-label="文档目录">
      {headings.map((h) => (
        <button
          key={h.id}
          class={"toc-row lvl-" + h.level + (h.id === activeId ? " active" : "")}
          title={h.text}
          onClick={() => jump(h.id)}
        >
          <span class="toc-tick" />
          <span class="toc-label">{h.text}</span>
        </button>
      ))}
    </nav>
  );
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
  const blocksRef = useRef<Block[]>([]);
  const sourceRef = useRef("");
  const sourceTaRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef("");
  const [mode, setModeState] = useState<DocMode>("blocks");
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [slash, setSlash] = useState<{ blockId: string; x: number; y: number; query: string; idx: number } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ x: number; y: number } | null>(null);
  // Block-level (multi-block) selection: a continuous anchor..focus range.
  // Independent from native text selection, because each block is its own
  // contentEditable host and the browser can't span a native selection across
  // them. null = no block selection (normal single-block editing).
  const [sel, setSel] = useState<{ anchorId: string; focusId: string } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  // ---- save pipeline state ----
  // version: the if_match token from the last read/save; dirty: unsaved local
  // edits exist; conflict: a save was rejected as stale (banner shown).
  const docVersionRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const retryDelayRef = useRef(0);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const [conflict, setConflict] = useState(false);

  // ---- undo/redo history ----
  // Structural block ops mutate blocksRef directly and aren't on the browser's
  // native undo stack, so we keep our own snapshot history and take over Ctrl+Z.
  // `present` is the snapshot as of the last recordHistory() call; a mutation
  // pushes it to `past`. Rapid same-block edits (typing) coalesce into one step.
  const history = useRef<{
    past: Snap[];
    future: Snap[];
    present: Snap | null;
    lastKey: string | null;
    lastTime: number;
  }>({ past: [], future: [], present: null, lastKey: null, lastTime: 0 });

  const snapshot = (): Snap => ({
    blocks: structuredClone(blocksRef.current),
    title: titleRef.current,
    focusId: focusedBlockId(),
  });

  const recordHistory = (coalesceKey: string | null) => {
    const h = history.current;
    if (!h.present) { h.present = snapshot(); h.lastKey = coalesceKey; h.lastTime = Date.now(); return; }
    const now = Date.now();
    if (coalesceKey && coalesceKey === h.lastKey && now - h.lastTime < 600) {
      h.present = snapshot(); // advance present to the latest state, no new step
      h.lastTime = now;
      return;
    }
    h.past.push(h.present);
    if (h.past.length > 200) h.past.shift();
    h.present = snapshot();
    h.future = [];
    h.lastKey = coalesceKey;
    h.lastTime = now;
  };

  const restoreSnap = (snap: Snap) => {
    blocksRef.current = structuredClone(snap.blocks);
    titleRef.current = snap.title;
    setSel(null);
    setVersion((v) => v + 1); // re-render without recording (bypasses bump)
    scheduleSave();
    if (snap.focusId) requestAnimationFrame(() => focusBlock(snap.focusId!, true));
  };

  const undo = () => {
    const h = history.current;
    if (!h.past.length) return;
    if (h.present) h.future.push(h.present);
    const prev = h.past.pop()!;
    h.present = prev;
    h.lastKey = null;
    restoreSnap(prev);
  };

  const redo = () => {
    const h = history.current;
    if (!h.future.length) return;
    if (h.present) h.past.push(h.present);
    const next = h.future.pop()!;
    h.present = next;
    h.lastKey = null;
    restoreSnap(next);
  };

  // Every structural mutation funnels through bump(); record a history step here.
  const bump = () => { recordHistory(null); setVersion((v) => v + 1); };

  const loadDoc = () => {
    setLoading(true);
    setSlash(null);
    setConflict(false);
    history.current = { past: [], future: [], present: null, lastKey: null, lastTime: 0 };
    api
      .getDocument(docId)
      .then((d) => {
        titleRef.current = d.title ?? "";
        sourceRef.current = d.body ?? "";
        blocksRef.current = blocksFromBody(d.body);
        docVersionRef.current = d.version ?? null;
        dirtyRef.current = false;
        setLoading(false);
        bump();
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

  const scheduleSave = () => {
    dirtyRef.current = true;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 700);
  };
  const snapshotMarkdown = () => {
    if (mode === "source") {
      sourceRef.current = sourceTaRef.current?.value ?? sourceRef.current;
      return sourceRef.current;
    }
    syncRenderedBlocks(blocksRef.current);
    return bodyFromBlocks(blocksRef.current);
  };
  // Saves are serialized through a chain so a debounced save never races a
  // flush: the later save reads the version the earlier one returned, keeping
  // if_match conflicts to *real* concurrent edits (CLI, sync, other windows).
  const doSave = (opts: { force?: boolean } = {}) =>
    api
      .updateDocument(docId, {
        title: titleRef.current,
        body: snapshotMarkdown(),
        ...(opts.force || docVersionRef.current == null
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
    if (next === "source") {
      sourceRef.current = snapshotMarkdown();
      setSlash(null);
      setBar(null);
      setSel(null);
      setModeState("source");
      onModeChange?.("source");
      requestAnimationFrame(() => {
        if (sourceTaRef.current) {
          sourceTaRef.current.value = sourceRef.current;
          resizeSourceEditor(sourceTaRef.current);
          sourceTaRef.current.focus();
        }
      });
      return;
    }

    sourceRef.current = sourceTaRef.current?.value ?? sourceRef.current;
    blocksRef.current = blocksFromBody(sourceRef.current);
    setModeState("blocks");
    onModeChange?.("blocks");
    setVersion((v) => v + 1);
    requestAnimationFrame(() => {
      const first = flattenBlocks(blocksRef.current)[0];
      if (first) focusBlock(first.id);
    });
  };

  useEffect(() => {
    onHandle?.({
      getMode: () => mode,
      setMode: setDisplayMode,
      snapshotMarkdown,
      flushSave,
    });
    return () => onHandle?.(null);
  }, [onHandle, mode]);

  const blocks = blocksRef.current;
  const selectedIds = sel ? blockRangeIds(blocks, sel.anchorId, sel.focusId) : [];

  const insertAfter = (afterId: string | null, type: BlockType = "p", draft: Partial<BlockDraft> = {}): Block => {
    const b = makeBlock(type, draft);
    if (!afterId) {
      blocks.push(b);
    } else {
      const found = findBlock(blocks, afterId);
      if (found) found.parent.splice(found.index + 1, 0, b);
      else blocks.push(b);
    }
    bump();
    requestAnimationFrame(() => focusBlock(b.id));
    scheduleSave();
    return b;
  };

  const convert = (id: string, type: BlockType, draft: Partial<BlockDraft> = {}) => {
    const found = findBlock(blocks, id);
    const b = found?.block;
    if (!b) return;
    // Converting between list types keeps the children; any other target drops them.
    const children = isListType(type) ? b.children : undefined;
    applyBlockDraft(b, type, draft);
    if (children?.length) b.children = children;
    else delete b.children;
    bump();
    if (type !== "divider" && type !== "table") requestAnimationFrame(() => focusBlock(id));
    scheduleSave();
  };

  const remove = (id: string) => {
    if (!removeBlockById(blocks, id)) return;
    bump();
    scheduleSave();
  };

  const onContentInput = (b: Block, el: HTMLElement) => {
    b.content = blockEditorText(b, el);
    recordHistory("text:" + b.id);
    // slash trigger / filter
    const text = el.textContent ?? "";
    if (text.startsWith("/")) {
      const r = caretRect();
      setSlash((s) => ({ blockId: b.id, x: r.x, y: r.y, query: text.slice(1), idx: s?.blockId === b.id ? s.idx : 0 }));
    } else if (slash) {
      setSlash(null);
    }
    scheduleSave();
  };

  // Paste: parse the clipboard as Markdown so it renders as real inline
  // formatting and block structure, instead of dropping in literal "**…**" or
  // collapsing everything into one flat paragraph. Prefer the `text/html` flavor
  // (which preserves code fences, headings, and lists when copied from a rendered
  // page like ChatGPT) and convert it to Markdown; fall back to `text/plain`.
  // Non-text payloads (images, files) fall through to the browser default.
  const onContentPaste = (e: ClipboardEvent, b: Block, el: HTMLElement) => {
    const html = e.clipboardData?.getData("text/html");
    const raw = html ? htmlToMarkdown(html) : (e.clipboardData?.getData("text/plain") ?? "");
    const text = raw.replace(/\r\n?/g, "\n");
    if (!text.trim()) return;
    e.preventDefault();
    const parsed = blocksFromBody(text);
    if (!parsed.length) return;
    const found = findBlock(blocks, b.id);
    if (!found) return;
    const { before, after } = splitEditableAtCaret(el);

    // A lone paragraph dropped into a line stays inline, so pasting a phrase like
    // "see **docs**" formats in place without splitting the block apart.
    if (parsed.length === 1 && parsed[0]!.type === "p" && (before.trim() !== "" || after.trim() !== "")) {
      b.content = before + parsed[0]!.content + after;
      const offset = inlineTextLength(before + parsed[0]!.content);
      bump();
      scheduleSave();
      requestAnimationFrame(() => focusBlockAtOffset(b.id, offset));
      return;
    }

    // Otherwise the line is split around the caret and the parsed blocks are
    // dropped in between: `before` stays in the current block (keeping its type),
    // `after` trails as a new paragraph after the pasted content.
    const insert: Block[] = [...parsed];
    const afterBlock = after.trim() !== "" ? makeBlock("p", { content: after }) : null;
    if (afterBlock) insert.push(afterBlock);

    if (before.trim() === "" && !found.block.children?.length) {
      found.parent.splice(found.index, 1, ...insert); // empty line: replace it
    } else {
      b.content = before;
      found.parent.splice(found.index + 1, 0, ...insert);
    }
    bump();
    scheduleSave();
    const caret = afterBlock ?? insert[insert.length - 1]!;
    requestAnimationFrame(() => focusBlock(caret.id, !afterBlock));
  };

  const slashMatches = slash
    ? BLOCK_MENU.filter((m) => (m.t + m.type + m.d).toLowerCase().includes(slash.query.toLowerCase()))
    : [];

  const applySlash = (m: { type: BlockType }) => {
    if (!slash) return;
    convert(slash.blockId, m.type);
    setSlash(null);
  };

  const applyShortcut = (b: Block, draft: BlockDraft) => {
    convert(b.id, draft.type, draft);
    setSlash(null);
  };

  const insertListChildFromShortcut = (b: Block, draft: BlockDraft) => {
    b.content = "";
    b.children ??= [];
    const child = makeBlock(draft.type, draft);
    b.children.unshift(child);
    setSlash(null);
    bump();
    requestAnimationFrame(() => focusBlock(child.id));
    scheduleSave();
  };

  const indent = (id: string) => {
    syncRenderedBlocks(blocks);
    if (!indentBlock(blocks, id)) return;
    bump();
    requestAnimationFrame(() => focusBlock(id));
    scheduleSave();
  };

  const outdent = (id: string) => {
    syncRenderedBlocks(blocks);
    if (!outdentBlock(blocks, id)) return;
    bump();
    requestAnimationFrame(() => focusBlock(id));
    scheduleSave();
  };

  const applyFormatCommand = async (cmd: string) => {
    if (cmd === "createLink") {
      // The link dialog steals focus — and the native selection with it — so
      // capture the range first and restore it after the dialog closes.
      const sel = getSelection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      if (!range || range.collapsed) return;
      setBar(null);
      const url = (await promptDialog({ title: "插入链接", label: "链接地址", placeholder: "https://…" }))?.trim();
      if (!url) return;
      const host = range.startContainer.parentElement?.closest?.(".editable") as HTMLElement | null;
      host?.focus();
      const s = getSelection();
      s?.removeAllRanges();
      s?.addRange(range);
      document.execCommand("createLink", false, url);
    } else if (cmd === "code") wrapInlineCode();
    else document.execCommand(cmd, false, undefined);
    syncFocusedBlock(blocks);
    scheduleSave();
    updateBar(setBar);
  };

  // ---- block-selection batch operations ----
  const clearSel = () => setSel(null);

  const selectAllBlocks = () => {
    const flat = flattenBlocks(blocks);
    if (!flat.length) return;
    enterBlockSelecting();
    setSel({ anchorId: flat[0]!.id, focusId: flat[flat.length - 1]!.id });
  };

  const deleteSelectedBlocks = (ids: string[]) => {
    syncRenderedBlocks(blocks);
    const focusId = deleteBlocks(blocks, ids);
    clearSel();
    bump();
    if (focusId) requestAnimationFrame(() => focusBlock(focusId, true));
    scheduleSave();
  };

  const indentSelectedBlocks = (ids: string[], dir: "indent" | "outdent") => {
    syncRenderedBlocks(blocks);
    const changed = dir === "indent" ? indentBlocks(blocks, ids) : outdentBlocks(blocks, ids);
    if (!changed.length) return;
    bump(); // keep the block selection; ids are unchanged by indent/outdent
    scheduleSave();
  };

  const duplicateSelectedBlocks = (ids: string[]) => {
    syncRenderedBlocks(blocks);
    const newIds = duplicateBlocks(blocks, ids);
    if (newIds.length) setSel({ anchorId: newIds[0]!, focusId: newIds[newIds.length - 1]! });
    bump();
    scheduleSave();
  };

  const copySelectedBlocks = (ids: string[]) => {
    const text = serializeBlocks(blocks, ids);
    if (text) navigator.clipboard?.writeText(text).catch(() => {});
  };

  // Block-mode keyboard: routed at the document level because the active
  // editable is blurred while a block selection is up, so keydowns would
  // otherwise never reach the .doc element. No-ops when there is no selection.
  const onBlockKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(".doc-source")) return;
    const mod = e.metaKey || e.ctrlKey;
    // Undo/redo: take over Ctrl/Cmd+Z so structural block ops are reversible
    // (the browser's native undo only covers intra-block text typing).
    if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && e.key === "y") { e.preventDefault(); redo(); return; }

    if (!sel) return;
    const ids = selectedIds;
    if (!ids.length) return;

    if (e.key === "Escape") { e.preventDefault(); const a = sel.anchorId; clearSel(); focusBlock(a, true); return; }
    if (e.key === "Tab") { e.preventDefault(); indentSelectedBlocks(ids, e.shiftKey ? "outdent" : "indent"); return; }
    if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); deleteSelectedBlocks(ids); return; }
    if (mod && e.key === "d") { e.preventDefault(); duplicateSelectedBlocks(ids); return; }
    if (mod && (e.key === "c" || e.key === "x")) {
      e.preventDefault();
      copySelectedBlocks(ids);
      if (e.key === "x") deleteSelectedBlocks(ids);
      return;
    }
    if (mod && e.key === "a") {
      e.preventDefault();
      selectAllBlocks();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const flat = flattenBlocks(blocks);
      const fi = flat.findIndex((b) => b.id === sel.focusId);
      if (fi < 0) return;
      if (e.shiftKey) {
        const ni = e.key === "ArrowDown" ? Math.min(fi + 1, flat.length - 1) : Math.max(fi - 1, 0);
        setSel({ anchorId: sel.anchorId, focusId: flat[ni]!.id });
      } else {
        const edge = e.key === "ArrowDown" ? ids[ids.length - 1]! : ids[0]!;
        clearSel();
        focusBlock(edge, e.key === "ArrowDown");
      }
      return;
    }
    if (e.key.length === 1 && !mod) {
      // any other printable key drops back into editing the last selected block
      const last = ids[ids.length - 1]!;
      clearSel();
      focusBlock(last, true);
    }
  };

  // ---- pointer-driven block selection (drag across blocks / gutter drag) ----
  const dragSel = useRef<
    { anchorId: string; started: boolean; sx: number; sy: number; mode: "text" | "block" } | null
  >(null);

  const onDocMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // let interactive affordances (gutter buttons, popovers, form controls, the
    // table column resizer) work
    if (target.closest(".gutter") || target.closest(".pop") || target.closest(".doc-col-resizer") || target.closest("input, button, select, a")) return;

    const blockEl = closestBlockElement(e.target as Node);
    const id = blockEl?.getAttribute("data-bid") ?? null;
    if (!id) {
      // Click landed outside any block. If it's in the doc's trailing blank area
      // (the big bottom padding), create or focus a trailing empty line.
      const doc = target.classList.contains("doc") ? target : null;
      if (mode === "blocks" && doc) {
        const blockEls = doc.querySelectorAll(".block");
        const ref = blockEls.length ? blockEls[blockEls.length - 1]! : doc.querySelector(".doc-meta");
        const contentBottom = ref ? ref.getBoundingClientRect().bottom : 0;
        if (e.clientY > contentBottom) {
          e.preventDefault();
          const last = blocks[blocks.length - 1];
          if (last && isBlankSpacer(last)) focusBlock(last.id, true);
          else insertAfter(null);
          return;
        }
      }
      clearSel();
      return;
    }

    if (e.shiftKey && sel) { // shift-click extends the current block selection
      e.preventDefault();
      enterBlockSelecting();
      setSel({ anchorId: sel.anchorId, focusId: id });
      return;
    }

    const inEditable = !!target.closest(".editable, .code-input, .doc-td");
    if (inEditable) {
      // start as text; promote to block mode only once the drag crosses a block
      dragSel.current = { anchorId: id, started: false, sx: e.clientX, sy: e.clientY, mode: "text" };
      if (sel) clearSel();
    } else {
      // pressed in the left margin / marker area → select the whole block now
      e.preventDefault();
      enterBlockSelecting();
      setSel({ anchorId: id, focusId: id });
      dragSel.current = { anchorId: id, started: true, sx: e.clientX, sy: e.clientY, mode: "block" };
    }
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragSel.current;
      if (!d) return;
      const overEl = document.elementFromPoint(e.clientX, e.clientY);
      const overId = (overEl?.closest(".block[data-bid]") as HTMLElement | null)?.getAttribute("data-bid") ?? null;
      if (d.mode === "text") {
        if (overId && overId !== d.anchorId) {
          d.mode = "block";
          enterBlockSelecting();
          setSel({ anchorId: d.anchorId, focusId: overId });
        }
        return;
      }
      if (!d.started && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 4) return;
      d.started = true;
      setSelectingClass(true);
      if (overId) setSel({ anchorId: d.anchorId, focusId: overId });
    };
    const up = () => { dragSel.current = null; setSelectingClass(false); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  // Route block-mode keystrokes from the document (latest closure via ref).
  const blockKeyRef = useRef(onBlockKeyDown);
  blockKeyRef.current = onBlockKeyDown;
  useEffect(() => {
    const h = (e: KeyboardEvent) => blockKeyRef.current(e);
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  }, []);

  // Keep the keyboard-highlighted slash item visible: the menu (.pop) is an
  // overflow:auto container, so arrow-key navigation must scroll the selected
  // item into view (block:"nearest" only scrolls when it's off-screen).
  useEffect(() => {
    if (!slash) return;
    popRef.current?.querySelector(".item.sel")?.scrollIntoView({ block: "nearest" });
  }, [slash?.idx, slash?.blockId]);

  // Dismiss the slash menu when the editing block loses focus. The menu items
  // suppress focus shift via onMouseDown+preventDefault, so clicking one keeps
  // the editable focused (no focusout) and lets its apply handler run; clicking
  // or tabbing anywhere else blurs the editable and closes the menu.
  useEffect(() => {
    if (!slash) return;
    const onBlur = () => setSlash(null);
    document.addEventListener("focusout", onBlur);
    return () => document.removeEventListener("focusout", onBlur);
  }, [!!slash]);

  const onKeyDown = (e: KeyboardEvent, b: Block, el: HTMLElement) => {
    if (slash && slash.blockId === b.id) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlash({ ...slash, idx: Math.min(slash.idx + 1, slashMatches.length - 1) }); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlash({ ...slash, idx: Math.max(slash.idx - 1, 0) }); return; }
      if (e.key === "Enter") { e.preventDefault(); const m = slashMatches[slash.idx]; if (m) applySlash(m); return; }
      if (e.key === "Escape") { setSlash(null); return; }
    }
    // Ctrl/Cmd+A: first press selects this block's text (native); a second press
    // while it's already fully selected escalates to selecting every block.
    if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
      if (blockTextFullySelected(el)) { e.preventDefault(); selectAllBlocks(); }
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      (e.shiftKey ? outdent : indent)(b.id);
      return;
    }
    // ↑/↓ cross block boundaries: only when the caret sits on the block's first
    // (↑) or last (↓) visual line, so multi-line wrapped text still moves between
    // its own lines natively. Skip while extending a selection (Shift).
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !hasExpandedSelection()) {
      const edge = caretLineEdge(el);
      if (e.key === "ArrowUp" && edge.first) {
        const prev = previousBlock(blocks, b.id);
        if (prev) { e.preventDefault(); focusBlock(prev.id, true); return; }
      } else if (e.key === "ArrowDown" && edge.last) {
        const next = nextBlock(blocks, b.id);
        if (next) { e.preventDefault(); focusBlock(next.id); return; }
      }
    }
    if (e.key === " " && !hasExpandedSelection() && (b.type === "p" || b.type === "bullet")) {
      // Match the marker against the text *before* the caret, not the whole line,
      // so a prefix typed at the start of a paragraph that already has content
      // ("1. " before "hello") still promotes the block — keeping the trailing
      // text as the new content.
      const { before, after } = splitEditableAtCaret(el);
      if (b.type === "p") {
        const shortcut = shortcutFromInput(before + " ", " ");
        if (shortcut) {
          e.preventDefault();
          applyShortcut(b, { ...shortcut, content: after });
          return;
        }
      } else {
        // A bullet completes the "- [ ]" prefix in a second stage: once "- "
        // already turned the block into a bullet, "[ ] "/"[x] " promotes it to a
        // todo. Keep any trailing text as the todo's content, mirroring the
        // paragraph path above.
        const todo = bulletTodoShortcut(before);
        if (todo) {
          e.preventDefault();
          convert(b.id, "todo", { content: after, checked: todo.checked });
          return;
        }
      }
    }
    if (e.key === "Enter" && !e.shiftKey && b.type !== "code") {
      const shortcut = shortcutFromInput((el.textContent ?? "").trim(), "Enter");
      if (shortcut) {
        e.preventDefault();
        if (isListType(b.type) && shortcut.type === "code") {
          insertListChildFromShortcut(b, shortcut);
          return;
        }
        applyShortcut(b, shortcut);
        return;
      }
      e.preventDefault();
      const empty = (el.textContent ?? "").trim() === "";
      if (isListType(b.type) && empty && !(b.children ?? []).length) { convert(b.id, "p"); return; }
      // Split at the caret: text before it stays in this block, text after it
      // moves into the new block (caret lands at its start). Empty `after`
      // degrades to the plain "new empty line below" behaviour.
      const { before, after } = splitEditableAtCaret(el);
      b.content = before;
      insertAfter(b.id, isListType(b.type) ? b.type : "p", { content: after });
    } else if (e.key === "Backspace") {
      if ((el.textContent ?? "") === "") {
        e.preventDefault();
        if (b.type !== "p") convert(b.id, "p");
        else {
          const prev = previousBlock(blocks, b.id);
          if (prev) { remove(b.id); requestAnimationFrame(() => focusBlock(prev.id, true)); }
        }
      } else if (!hasExpandedSelection() && caretAtBlockStart(el)) {
        if (isListType(b.type)) {
          // Backspace at the very start of a non-empty list item strips the list
          // marker, turning it into a plain paragraph while keeping its text.
          e.preventDefault();
          convert(b.id, "p", { content: blockEditorText(b, el) });
        } else {
          // Backspace at the start of a non-empty block merges it up into the
          // previous text block (deletes the "line break" — the inverse of the
          // Enter split). Skip when there is no previous block or it has no
          // editable text (code/table/divider).
          const prev = previousBlock(blocks, b.id);
          if (prev && prev.type !== "code" && prev.type !== "table" && prev.type !== "divider") {
            e.preventDefault();
            const offset = inlineTextLength(prev.content); // caret lands at the join
            prev.content += blockEditorText(b, el);
            remove(b.id);
            requestAnimationFrame(() => {
              // Write the merged HTML ourselves before placing the caret, so the
              // block's own renderKey effect sees matching HTML and won't rewrite
              // it afterwards (which would reset the caret to the block start).
              const pe = document.querySelector(`.block[data-bid="${prev.id}"] .editable`) as HTMLElement | null;
              if (pe) {
                const html = inlineToHtml(prev.content);
                if (pe.innerHTML !== html) pe.innerHTML = html;
              }
              focusBlockAtOffset(prev.id, offset);
            });
          }
        }
      }
    }
  };

  // Code blocks use a real <textarea>, so they get their own key handler instead
  // of the contentEditable one. This is also where "escape the code block"
  // lives: Enter on a trailing blank line, or ↓ on the last line, exits below.
  const onCodeKeyDown = (e: KeyboardEvent, b: Block, ta: HTMLTextAreaElement) => {
    const { value, selectionStart: start, selectionEnd: end } = ta;
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        syncRenderedBlocks(blocks);
        if (outdentBlock(blocks, b.id)) {
          bump();
          requestAnimationFrame(() => focusBlock(b.id));
          scheduleSave();
        }
        return;
      }
      document.execCommand("insertText", false, "  "); // keeps native undo + fires input
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && start === end) {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const nlAfter = value.indexOf("\n", start);
      const lastLine = nlAfter === -1;
      const lineEmpty = value.slice(lineStart, lastLine ? undefined : nlAfter).trim() === "";
      if (lastLine && lineEmpty) {
        e.preventDefault();
        b.content = value.replace(/\n[ \t]*$/, "");
        insertAfter(b.id, "p");
      }
      return;
    }
    if (e.key === "ArrowDown" && start === end && value.indexOf("\n", start) === -1) {
      e.preventDefault();
      const next = nextBlock(blocks, b.id);
      if (next) focusBlock(next.id);
      else insertAfter(b.id, "p");
      return;
    }
    if (e.key === "ArrowUp" && start === end && value.lastIndexOf("\n", start - 1) === -1) {
      e.preventDefault();
      const prev = previousBlock(blocks, b.id);
      if (prev) focusBlock(prev.id, true);
      return;
    }
    if (e.key === "Backspace" && value === "") {
      e.preventDefault();
      const found = findBlock(blocks, b.id);
      const parent = found?.parentBlock;
      if (found && parent && isListType(parent.type) && parent.content.trim() === "") {
        found.parent.splice(found.index, 1);
        if (found.parent.length === 0) delete parent.children;
        bump();
        requestAnimationFrame(() => focusBlock(parent.id));
        scheduleSave();
        return;
      }
      convert(b.id, "p");
    }
  };

  const blockMenu = (e: MouseEvent, b: Block) => {
    e.stopPropagation();
    openMenu(e, (close) => (
      <>
        <MenuLabel>转换为</MenuLabel>
        {BLOCK_MENU.filter((m) => m.type !== "divider").map((m) => (
          <MenuItem key={m.type} icon={m.ic} label={m.t} checked={b.type === m.type} onClick={() => { convert(b.id, m.type); close(); }} />
        ))}
        <MenuSep />
        <MenuItem icon="copy" label="复制块" onClick={() => { const found = findBlock(blocks, b.id); if (found) found.parent.splice(found.index + 1, 0, cloneBlock(b)); bump(); scheduleSave(); close(); }} />
        <MenuItem icon="trash" label="删除块" danger onClick={() => { remove(b.id); close(); }} />
      </>
    ));
  };

  // drag reorder
  const dragRef = useRef<string | null>(null);

  if (loading) return <div class="empty">加载中…</div>;

  const selectedSet = new Set(selectedIds);
  const renderBlocks = (items: Block[], depth = 0): ComponentChildren => {
    const numbers = computeListNumbers(items.filter((b) => !isBlankSpacer(b)));
    return items.map((b) => (
      <BlockRow
        key={b.id}
        renderKey={version}
        block={b}
        depth={depth}
        selected={selectedSet.has(b.id)}
        number={b.type === "numbered" ? (numbers.get(b.id) ?? 1) : 0}
        onInput={(el) => onContentInput(b, el)}
        onPaste={(e, el) => onContentPaste(e, b, el)}
        onLangInput={(lang) => { b.lang = lang; bump(); scheduleSave(); }}
        onKeyDown={(e, el) => onKeyDown(e, b, el)}
        onCodeInput={(value) => { b.content = value; recordHistory("text:" + b.id); scheduleSave(); }}
        onCodeKeyDown={(e, ta) => onCodeKeyDown(e, b, ta)}
        onCellInput={(r, c, value) => {
          if (!b.rows?.[r]) return;
          b.rows[r]![c] = value;
          recordHistory("table:" + b.id + ":" + r + ":" + c);
          scheduleSave();
        }}
        onTableChange={() => { bump(); scheduleSave(); }}
        onAdd={() => insertAfter(b.id)}
        onMenu={(e) => blockMenu(e, b)}
        onToggle={() => { b.checked = !b.checked; bump(); scheduleSave(); }}
        dragRef={dragRef}
        onReorder={(srcId, where) => {
          const ids = selectedIds;
          const moved = ids.length > 1 && ids.includes(srcId)
            ? moveBlocks(blocks, ids, b.id, where)
            : moveBlock(blocks, srcId, b.id, where);
          if (moved) {
            bump();
            scheduleSave();
          }
        }}
      >
        {b.children?.length ? renderBlocks(b.children, depth + 1) : null}
      </BlockRow>
    ));
  };

  return (
    <>
    {mode === "blocks" && <DocToc key={version} blocks={blocks} />}
    <div
      class={"doc" + (mode === "source" ? " source-mode" : "")}
      onMouseDown={(e) => onDocMouseDown(e as MouseEvent)}
      onMouseUp={() => updateBar(setBar)}
      onKeyUp={(e) => { if (e.shiftKey || e.key.startsWith("Arrow")) updateBar(setBar); }}
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
        onInput={(e) => { titleRef.current = (e.target as HTMLElement).textContent ?? ""; recordHistory("title"); scheduleSave(); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (!blocks.length) insertAfter(null); else focusBlock(blocks[0]!.id); } }}
        dangerouslySetInnerHTML={{ __html: titleRef.current }}
      />
      <div class="doc-meta">
        <span><Icon name="file" cls="ico sm" />{countBlocks(blocks)} 个块</span>
        <span>实时同步</span>
      </div>

      {mode === "source" ? (
        <textarea
          ref={sourceTaRef}
          class="doc-source"
          spellcheck={false}
          defaultValue={sourceRef.current}
          onInput={(e) => {
            const ta = e.currentTarget as HTMLTextAreaElement;
            sourceRef.current = ta.value;
            resizeSourceEditor(ta);
            scheduleSave();
          }}
        />
      ) : renderBlocks(blocks)}

      {mode === "blocks" && blocks.length === 0 && (
        <div class="editable" style={{ color: "var(--muted)", cursor: "text" }} onClick={() => insertAfter(null)}>
          点此书写，或输入 “/” 选择块类型…
        </div>
      )}

      {slash && slashMatches.length > 0 && (() => {
        // Place below the caret by default; flip above when there isn't enough room,
        // and cap max-height to the available space so the menu scrolls (overflow:auto)
        // instead of overflowing the viewport and clipping its bottom.
        const GAP = 22, M = 8;
        const spaceBelow = innerHeight - (slash.y + GAP) - M;
        const spaceAbove = slash.y - M;
        const below = spaceBelow >= 240 || spaceBelow >= spaceAbove;
        const left = Math.min(slash.x, innerWidth - 270);
        const maxHeight = Math.min(below ? spaceBelow : spaceAbove, Math.round(innerHeight * 0.7));
        const style = below
          ? { left, top: slash.y + GAP, maxHeight, minWidth: 260 }
          : { left, bottom: innerHeight - slash.y + 6, maxHeight, minWidth: 260 };
        return (
          <div class="pop" style={style} ref={popRef}>
            <MenuLabel>基础块</MenuLabel>
            {slashMatches.map((m, i) => (
              <button key={m.type} class={"item" + (i === slash.idx ? " sel" : "")} onMouseDown={(e) => { e.preventDefault(); applySlash(m); }}>
                <span class="lico"><Icon name={m.ic} cls="ico sm" /></span>
                <span class="meta"><span class="t">{m.t}</span><span class="d">{m.d}</span></span>
              </button>
            ))}
          </div>
        );
      })()}

      {bar && !sel && <FormatBar x={bar.x} y={bar.y} onCommand={applyFormatCommand} />}
    </div>
    </>
  );
}

function BlockRow({
  block, number, depth, renderKey, selected, onInput, onPaste, onLangInput, onKeyDown, onCodeInput, onCodeKeyDown, onCellInput, onTableChange, onAdd, onMenu, onToggle, dragRef, onReorder, children,
}: {
  block: Block;
  number: number;
  depth: number;
  renderKey: number;
  selected: boolean;
  onInput: (el: HTMLElement) => void;
  onPaste: (e: ClipboardEvent, el: HTMLElement) => void;
  onLangInput: (lang: string) => void;
  onKeyDown: (e: KeyboardEvent, el: HTMLElement) => void;
  onCodeInput: (value: string) => void;
  onCodeKeyDown: (e: KeyboardEvent, ta: HTMLTextAreaElement) => void;
  onCellInput: (r: number, c: number, value: string) => void;
  onTableChange: () => void;
  onAdd: () => void;
  onMenu: (e: MouseEvent) => void;
  onToggle: () => void;
  dragRef: { current: string | null };
  onReorder: (srcId: string, where: "before" | "after") => void;
  children?: ComponentChildren;
}) {
  const edRef = useRef<HTMLDivElement>(null);
  // Uncontrolled: set innerHTML only on structural changes (renderKey/type), not
  // on every re-render, so typing — including a `/` query that re-renders the
  // doc to show the slash menu — never resets the caret. Code blocks render via
  // <CodeBlock> (textarea), so they don't use edRef.
  // renderKey is a global version counter, so every structural mutation re-runs
  // this for *all* blocks. Only rewrite when the HTML actually differs, otherwise
  // an unrelated edit (e.g. deleting another block) would clobber a caret we just
  // placed here — landing it at the block's start instead of where it was set.
  useEffect(() => {
    if (edRef.current && block.type !== "code") {
      const html = inlineToHtml(block.content);
      if (edRef.current.innerHTML !== html) edRef.current.innerHTML = html;
    }
  }, [renderKey, block.type]);
  const compactCodeHost =
    isListType(block.type) && block.content.trim() === "" && block.children?.[0]?.type === "code";
  const cls =
    "block b-" +
    block.type +
    (block.type === "todo" && block.checked ? " b-done" : "") +
    (compactCodeHost ? " list-code-host" : "") +
    (selected ? " selected" : "");
  return (
    <div class={"block-wrap" + (depth ? " nested" : "")}>
      <div
        class={cls}
        data-bid={block.id}
        onDragOver={(e) => {
          if (dragRef.current && dragRef.current !== block.id) {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            markBlockDrop(e.currentTarget as HTMLElement, e);
          }
        }}
        onDrop={(e) => {
          if (!dragRef.current) return;
          e.preventDefault();
          const where = (e.currentTarget as HTMLElement).classList.contains("drop-after") ? "after" : "before";
          const src = dragRef.current; dragRef.current = null; clearBlockDrop();
          onReorder(src, where);
        }}
      >
        <div class="gutter">
          <button title="在下方插入" onClick={onAdd}><Icon name="plus" cls="ico sm" /></button>
          <button
            class="grip"
            title="拖拽移动 · 点击菜单"
            draggable
            onClick={onMenu}
            onDragStart={(e) => {
              dragRef.current = block.id;
              if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", block.id);
              }
              (e.currentTarget!.closest(".block") as HTMLElement).classList.add("dragging");
            }}
            onDragEnd={(e) => { (e.currentTarget!.closest(".block") as HTMLElement).classList.remove("dragging"); clearBlockDrop(); }}
          >
            <Icon name="grip" cls="ico sm" />
          </button>
        </div>

        {block.type === "divider" ? (
          <hr />
        ) : block.type === "table" ? (
          <TableBlock block={block} renderKey={renderKey} onCellInput={onCellInput} onTableChange={onTableChange} />
        ) : (
          <>
            {block.type === "bullet" && <div class="marker">•</div>}
            {block.type === "numbered" && <div class="marker">{number}.</div>}
            {block.type === "todo" && (
              <div class="marker"><input type="checkbox" checked={!!block.checked} onChange={onToggle} /></div>
            )}
            {compactCodeHost ? null : block.type === "code" ? (
              <CodeBlock
                block={block}
                renderKey={renderKey}
                onInput={onCodeInput}
                onLangChange={onLangInput}
                onKeyDown={onCodeKeyDown}
              />
            ) : (
              <div
                ref={edRef}
                class="editable"
                contentEditable
                data-ph={placeholder(block.type)}
                data-ph-hint={isSlashHint(block.type) ? "slash" : "kind"}
                onInput={(e) => onInput(e.currentTarget as HTMLElement)}
                onPaste={(e) => onPaste(e as ClipboardEvent, e.currentTarget as HTMLElement)}
                onKeyDown={(e) => onKeyDown(e, e.currentTarget as HTMLElement)}
              />
            )}
          </>
        )}
      </div>
      {children}
    </div>
  );
}

const KIND_HINTS: Record<string, string> = { h1: "标题 1", h2: "标题 2", h3: "标题 3", code: "输入代码…", quote: "引用" };

function placeholder(t: BlockType): string {
  // Kind-hint blocks (headings/quote/code) always show their hint; everything
  // else falls through to the generic "/" prompt.
  return KIND_HINTS[t] ?? "输入文本，“/” 唤出命令";
}

// True when the block carries the generic "/" prompt rather than a kind hint.
// The "/" prompt shows only while the line is focused (see the
// `.editable[data-ph-hint="slash"]:empty:not(:focus)` CSS rule), so idle blank
// lines — paragraphs and list items alike, at any nesting depth — read as real
// empty space, while the line with the caret still prompts "/". Keying on the
// hint kind (not the block type) keeps paragraphs and lists consistent.
function isSlashHint(t: BlockType): boolean {
  return !(t in KIND_HINTS);
}

// ---- code block: transparent textarea over a highlight.js mirror ----
function CodeBlock({
  block, renderKey, onInput, onLangChange, onKeyDown,
}: {
  block: Block;
  renderKey: number;
  onInput: (value: string) => void;
  onLangChange: (lang: string) => void;
  onKeyDown: (e: KeyboardEvent, ta: HTMLTextAreaElement) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLElement>(null);
  const gutRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  // Repaint the highlight mirror + line-number gutter, and grow the textarea to
  // fit its content (so the block has no inner vertical scroll).
  const paint = (value: string) => {
    if (hlRef.current) hlRef.current.innerHTML = highlightCode(value, block.lang);
    if (gutRef.current) {
      const lines = value.split("\n").length;
      let s = "1";
      for (let i = 2; i <= lines; i++) s += "\n" + i;
      gutRef.current.textContent = s;
    }
    const ta = taRef.current;
    if (ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
  };

  // Uncontrolled, like the contentEditable blocks: only push value on structural
  // change or language switch, never on every keystroke (would reset the caret).
  useEffect(() => {
    const ta = taRef.current;
    if (ta && ta.value !== block.content) ta.value = block.content;
    paint(block.content);
  }, [renderKey, block.lang]);

  const lang = block.lang ?? "";
  const langKnown = COMMON_LANGS.some((l) => l.id === lang);

  return (
    <div class="codeblock">
      <div class="code-body">
        <div ref={gutRef} class="code-gutter" aria-hidden="true">1</div>
        <div class="code-scroll">
          <pre class="code-hl" aria-hidden="true"><code ref={hlRef} class="hljs" /></pre>
          <textarea
            ref={taRef}
            class="code-input"
            rows={1}
            spellcheck={false}
            wrap="off"
            placeholder="输入代码…"
            onInput={(e) => { const ta = e.currentTarget as HTMLTextAreaElement; onInput(ta.value); paint(ta.value); }}
            onKeyDown={(e) => onKeyDown(e, e.currentTarget as HTMLTextAreaElement)}
            onScroll={(e) => {
              const pre = hlRef.current?.parentElement as HTMLElement | null;
              if (pre) pre.scrollLeft = (e.currentTarget as HTMLTextAreaElement).scrollLeft;
            }}
          />
        </div>
      </div>
      <div class="code-tools">
        <span class="code-lang">
          <select value={lang} onChange={(e) => onLangChange((e.currentTarget as HTMLSelectElement).value)}>
            {!langKnown && <option value={lang}>{lang || "纯文本"}</option>}
            {COMMON_LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          <Icon name="chevronDown" cls="ico sm" />
        </span>
        <button
          class={"code-copy" + (copied ? " ok" : "")}
          title="复制代码"
          onClick={() => {
            const text = taRef.current?.value ?? block.content;
            navigator.clipboard?.writeText(text)
              .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })
              .catch(() => {});
          }}
        >
          <Icon name={copied ? "check" : "copy"} cls="ico sm" />
          {copied ? "已复制" : "复制"}
        </button>
      </div>
    </div>
  );
}

// ---- table block ----
// A GFM pipe table rendered as a real <table> of contentEditable cells. Cell
// edits are uncontrolled (innerHTML rewritten only on a structural re-render, via
// renderKey) so typing never resets the caret — same pattern as the .editable /
// CodeBlock hosts. Structural ops (add/del row & col, alignment) go through
// onTableChange → bump(). Column widths are session-only: kept in a ref and
// written straight onto the <col> elements, never serialized to Markdown.
function TableBlock({
  block, renderKey, onCellInput, onTableChange,
}: {
  block: Block;
  renderKey: number;
  onCellInput: (r: number, c: number, value: string) => void;
  onTableChange: () => void;
}) {
  const rows = block.rows ?? [];
  const cols = rows[0]?.length ?? 0;
  const align = block.align ?? [];
  const tableRef = useRef<HTMLTableElement>(null);
  const widths = useRef<number[]>([]);
  // Keep the session-only width array sized to the column count; new columns
  // inherit the default, existing widths are preserved across re-renders.
  if (widths.current.length !== cols) {
    widths.current = Array.from({ length: cols }, (_, c) => widths.current[c] ?? 160);
  }

  const addRow = () => { block.rows = [...rows, new Array(cols).fill("")]; onTableChange(); };
  const addCol = () => {
    block.rows = rows.map((r) => [...r, ""]);
    block.align = [...align, null];
    onTableChange();
  };
  const insertCol = (at: number) => {
    block.rows = rows.map((r) => { const n = [...r]; n.splice(at, 0, ""); return n; });
    const a = [...align]; a.splice(at, 0, null); block.align = a;
    onTableChange();
  };
  const deleteCol = (c: number) => {
    if (cols <= 1) return;
    block.rows = rows.map((r) => r.filter((_, i) => i !== c));
    block.align = align.filter((_, i) => i !== c);
    onTableChange();
  };
  const deleteRow = (r: number) => {
    if (r === 0 || rows.length <= 2) return; // keep the header + at least one body row
    block.rows = rows.filter((_, i) => i !== r);
    onTableChange();
  };
  const setAlign = (c: number, a: ColAlign) => {
    const next = Array.from({ length: cols }, (_, i) => align[i] ?? null);
    next[c] = a;
    block.align = next;
    onTableChange();
  };

  // Move focus by (dr, dc) within this table; returns false if out of bounds.
  const focusCell = (r: number, c: number): boolean => {
    const el = tableRef.current?.querySelector<HTMLElement>(`.doc-td[data-r="${r}"][data-c="${c}"]`);
    if (!el) return false;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const s = getSelection();
    s?.removeAllRanges();
    s?.addRange(range);
    return true;
  };

  const onCellKeyDown = (e: KeyboardEvent, r: number, c: number) => {
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        if (c > 0) focusCell(r, c - 1);
        else if (r > 0) focusCell(r - 1, cols - 1);
      } else {
        if (c < cols - 1) focusCell(r, c + 1);
        else if (r < rows.length - 1) focusCell(r + 1, 0);
        else { addRow(); requestAnimationFrame(() => focusCell(rows.length, 0)); }
      }
      return;
    }
    if (e.key === "Enter") {
      // Cells are single-line; Enter steps to the row below instead of inserting a <br>.
      e.preventDefault();
      if (r < rows.length - 1) focusCell(r + 1, c);
      else { addRow(); requestAnimationFrame(() => focusCell(rows.length, c)); }
      return;
    }
  };

  const startResize = (e: PointerEvent, c: number) => {
    e.preventDefault();
    e.stopPropagation();
    startColumnResize(e, {
      col: tableRef.current?.querySelector<HTMLElement>(`col[data-tcol="${c}"]`) ?? null,
      startWidth: widths.current[c] ?? 160,
      min: 60,
      onDone: (w) => { widths.current[c] = w; },
    });
  };

  const colMenu = (e: MouseEvent, c: number) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e, (close) => (
      <>
        <MenuLabel>对齐方式</MenuLabel>
        <MenuItem icon="alignLeft" label="左对齐" checked={(align[c] ?? null) === null || align[c] === "left"} onClick={() => { setAlign(c, "left"); close(); }} />
        <MenuItem icon="alignCenter" label="居中" checked={align[c] === "center"} onClick={() => { setAlign(c, "center"); close(); }} />
        <MenuItem icon="alignRight" label="右对齐" checked={align[c] === "right"} onClick={() => { setAlign(c, "right"); close(); }} />
        <MenuSep />
        <MenuItem icon="plus" label="在左侧插入列" onClick={() => { insertCol(c); close(); }} />
        <MenuItem icon="cornerUpRight" label="在右侧插入列" onClick={() => { insertCol(c + 1); close(); }} />
        <MenuItem icon="trash" label="删除列" danger onClick={() => { deleteCol(c); close(); }} />
      </>
    ));
  };

  return (
    <div class="doc-table-wrap">
      <div class="doc-table-scroll">
        <div class="doc-table-inner">
          <div class="doc-table-row">
            <table ref={tableRef} class="doc-table">
              <colgroup>
                {Array.from({ length: cols }, (_, c) => (
                  <col key={c} data-tcol={c} style={{ width: widths.current[c] }} />
                ))}
              </colgroup>
              <tbody>
                {rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} class={r === 0 ? "doc-th" : undefined}>
                        <TableCell
                          value={cell}
                          renderKey={renderKey}
                          r={r}
                          c={c}
                          align={align[c] ?? null}
                          onInput={(v) => onCellInput(r, c, v)}
                          onKeyDown={(e) => onCellKeyDown(e, r, c)}
                        />
                        {r === 0 && (
                          <>
                            <button class="doc-col-menu" title="列选项" onMouseDown={(e) => colMenu(e as MouseEvent, c)}>
                              <Icon name="chevronDown" cls="ico sm" />
                            </button>
                            <div class="doc-col-resizer" onPointerDown={(e) => startResize(e as PointerEvent, c)} />
                          </>
                        )}
                        {c === 0 && r > 0 && rows.length > 2 && (
                          <button class="doc-row-del" title="删除行" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); deleteRow(r); }}>
                            <Icon name="trash" cls="ico sm" />
                          </button>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <button class="doc-table-addcol" title="新增列" onMouseDown={(e) => { e.preventDefault(); addCol(); }}>
              <Icon name="plus" cls="ico sm" />
            </button>
          </div>
          <button class="doc-table-addrow" title="新增行" onMouseDown={(e) => { e.preventDefault(); addRow(); }}>
            <Icon name="plus" cls="ico sm" />
          </button>
        </div>
      </div>
    </div>
  );
}

function TableCell({
  value, renderKey, r, c, align, onInput, onKeyDown,
}: {
  value: string;
  renderKey: number;
  r: number;
  c: number;
  align: ColAlign;
  onInput: (value: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Uncontrolled: rewrite innerHTML only on a structural re-render (renderKey),
  // never on every keystroke — mirrors the .editable host so the caret survives.
  useEffect(() => {
    if (ref.current) {
      const html = inlineToHtml(value);
      if (ref.current.innerHTML !== html) ref.current.innerHTML = html;
    }
  }, [renderKey]);
  return (
    <div
      ref={ref}
      class="doc-td"
      data-r={r}
      data-c={c}
      contentEditable
      data-ph={r === 0 ? "表头" : ""}
      style={align ? { textAlign: align } : undefined}
      onInput={(e) => onInput(htmlToInline((e.currentTarget as HTMLElement).innerHTML))}
      onKeyDown={(e) => onKeyDown(e as KeyboardEvent)}
    />
  );
}

// ---- inline formatting toolbar ----
function FormatBar({ x, y, onCommand }: { x: number; y: number; onCommand: (cmd: string) => void }) {
  const run = (cmd: string) => (e: MouseEvent) => {
    e.preventDefault();
    onCommand(cmd);
  };
  return (
    <div class="pop" style={{ left: Math.max(8, Math.min(x, innerWidth - 220)), top: y - 46, minWidth: 0, padding: 3, display: "flex", gap: 1 }}>
      {[["bold", "bold"], ["italic", "italic"], ["underline", "underline"], ["strikeThrough", "strike"], ["code", "code"], ["createLink", "link"]].map(
        ([cmd, ic]) => (
          <button key={cmd} class="item" style={{ width: 34, justifyContent: "center", padding: "7px 0" }} onMouseDown={run(cmd!)}>
            <Icon name={ic!} cls="ico sm" />
          </button>
        ),
      )}
    </div>
  );
}
function wrapInlineCode() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString();
  document.execCommand("insertHTML", false, `<code>${text.replace(/</g, "&lt;")}</code>`);
}

function syncRenderedBlocks(blocks: Block[]) {
  document.querySelectorAll(".doc .block[data-bid]").forEach((el) => syncBlockElement(blocks, el as HTMLElement));
}

function syncBlockElement(blocks: Block[], el: HTMLElement) {
  const blockEl = el.matches(".block[data-bid]") ? el : (el.closest(".block[data-bid]") as HTMLElement | null);
  const id = blockEl?.getAttribute("data-bid");
  const block = id ? findBlock(blocks, id)?.block : null;
  if (!block || !blockEl) return;
  const editable = blockEl.querySelector(".editable") as HTMLElement | null;
  const code = blockEl.querySelector(".code-input") as HTMLTextAreaElement | null;
  if (editable) block.content = blockEditorText(block, editable);
  else if (code) block.content = code.value;
}

function closestBlockElement(node: Node): HTMLElement | null {
  const el = node instanceof HTMLElement ? node : node.parentElement;
  return (el?.closest(".block[data-bid]") as HTMLElement | null) ?? null;
}

// A document snapshot for the undo/redo history.
interface Snap {
  blocks: Block[];
  title: string;
  focusId: string | null;
}

function focusedBlockId(): string | null {
  const el = document.activeElement as HTMLElement | null;
  const block = el?.closest?.(".doc .block[data-bid]") as HTMLElement | null;
  return block?.getAttribute("data-bid") ?? null;
}

// Toggle native text selectability off during a block-selection drag so the
// browser doesn't paint a stray character highlight underneath the block tint.
function setSelectingClass(on: boolean) {
  document.querySelector(".doc")?.classList.toggle("selecting", on);
}

// Enter block-selection mode: drop any native caret/selection and blur the
// active editable so keystrokes route to the document-level handler.
function enterBlockSelecting() {
  getSelection()?.removeAllRanges();
  (document.activeElement as HTMLElement | null)?.blur?.();
  setSelectingClass(true);
}

function updateBar(setBar: (b: { x: number; y: number } | null) => void) {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return setBar(null);
  const node = sel.anchorNode;
  if (!(node?.parentElement?.closest?.(".editable"))) return setBar(null);
  const range = sel.getRangeAt(0);
  const r = range.getBoundingClientRect();
  const firstRect = r.width || r.height ? r : range.getClientRects()[0];
  if (!firstRect) return setBar(null);
  setBar({ x: firstRect.left, y: firstRect.top });
}
function syncFocusedBlock(blocks: Block[]) {
  const el = getSelection()?.anchorNode?.parentElement?.closest?.(".editable") as HTMLElement | null;
  const wrap = el?.closest(".block") as HTMLElement | null;
  const id = wrap?.getAttribute("data-bid");
  const b = id ? findBlock(blocks, id)?.block : null;
  if (b && el) b.content = blockEditorText(b, el);
}

function blockEditorText(_block: Block, el: HTMLElement): string {
  return htmlToInline(el.innerHTML);
}

function hasExpandedSelection(): boolean {
  const sel = getSelection();
  return !!sel && !sel.isCollapsed;
}
// Is the collapsed caret at the very start of `el` (nothing rendered before it)?
function caretAtBlockStart(el: HTMLElement): boolean {
  const sel = getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return false;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length === 0;
}

// ---- caret + drag helpers ----
function caretRect(): { x: number; y: number } {
  const sel = getSelection();
  if (!sel || !sel.rangeCount) return { x: 80, y: 120 };
  const r = sel.getRangeAt(0).getBoundingClientRect();
  return { x: r.left || 80, y: r.top || 120 };
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
// Does the current selection cover all of the editable's text? Compares selected
// text length against the block's text rather than range boundary points, so the
// browser's trailing bogus <br> (which selectNodeContents would include but Ctrl+A
// won't) can't throw the comparison off. An empty block counts as fully selected,
// so Ctrl+A escalates straight to all-block selection.
function blockTextFullySelected(el: HTMLElement): boolean {
  const text = el.textContent ?? "";
  if (text.trim() === "") return true;
  const sel = getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
  if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return false;
  return sel.toString().length >= text.length;
}
// Split an editable's contents at the caret (or around its selection) into
// inline-Markdown strings, so a paste can rejoin the text on either side.
function splitEditableAtCaret(el: HTMLElement): { before: string; after: string } {
  const sel = getSelection();
  if (!sel || !sel.rangeCount || !el.contains(sel.getRangeAt(0).startContainer)) {
    return { before: htmlToInline(el.innerHTML), after: "" };
  }
  const range = sel.getRangeAt(0);
  const toInline = (set: (r: Range) => void) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    set(r);
    const div = document.createElement("div");
    div.appendChild(r.cloneContents());
    return htmlToInline(div.innerHTML);
  };
  return {
    before: toInline((r) => r.setEnd(range.startContainer, range.startOffset)),
    after: toInline((r) => r.setStart(range.endContainer, range.endOffset)),
  };
}
// Rendered (visible) text length of an inline-Markdown string — used to land the
// caret right after freshly pasted inline content.
function inlineTextLength(src: string): number {
  const div = document.createElement("div");
  div.innerHTML = inlineToHtml(src);
  return (div.textContent ?? "").length;
}
// Place the caret at a visible-text offset inside a block's editable.
function focusBlockAtOffset(id: string, offset: number) {
  const el = document.querySelector(`.block[data-bid="${id}"] .editable`) as HTMLElement | null;
  if (!el) return;
  el.focus();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let target: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    target = node;
    if (remaining <= node.data.length) break;
    remaining -= node.data.length;
  }
  const range = document.createRange();
  if (target) range.setStart(target, Math.min(remaining, target.data.length));
  else { range.selectNodeContents(el); }
  range.collapse(true);
  const s = getSelection();
  s?.removeAllRanges();
  s?.addRange(range);
}
function focusBlock(id: string, atEnd = false) {
  const sel = `.block[data-bid="${id}"] .editable, .block[data-bid="${id}"] .code-input`;
  const el = document.querySelector(sel) as HTMLElement | null;
  if (!el) return;
  el.focus();
  if (el instanceof HTMLTextAreaElement) {
    const pos = atEnd ? el.value.length : 0;
    el.setSelectionRange(pos, pos);
    return;
  }
  // Always set the caret explicitly (start or end), never rely on the browser's
  // post-focus default: after a structural re-render rewrites this block's
  // innerHTML, an unset caret lands at position 0 and races the rewrite.
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(!atEnd); // !atEnd -> start, atEnd -> end
  const s = getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
}
function resizeSourceEditor(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}
const clearBlockDrop = clearDropMarks;
function markBlockDrop(el: HTMLElement, e: DragEvent) {
  markDropHalf(el, e, "y");
}
