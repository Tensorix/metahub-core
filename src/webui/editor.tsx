/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { Icon } from "./icons.tsx";
import { openMenu, MenuItem, MenuLabel, MenuSep } from "./ui.tsx";
import hljs from "highlight.js/lib/common";
import {
  type Block,
  type BlockDraft,
  type BlockType,
  BLOCK_MENU,
  COMMON_LANGS,
  blockToText,
  blocksFromBody,
  bodyFromBlocks,
  computeListNumbers,
  genId,
  isListType,
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

export function DocView({
  docId,
  onTitleChange,
  onError,
}: {
  docId: string;
  onTitleChange: () => void;
  onError: (m: string) => void;
}) {
  const blocksRef = useRef<Block[]>([]);
  const titleRef = useRef("");
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [slash, setSlash] = useState<{ blockId: string; x: number; y: number; query: string; idx: number } | null>(null);
  const [bar, setBar] = useState<{ x: number; y: number } | null>(null);
  // Block-level (multi-block) selection: a continuous anchor..focus range.
  // Independent from native text selection, because each block is its own
  // contentEditable host and the browser can't span a native selection across
  // them. null = no block selection (normal single-block editing).
  const [sel, setSel] = useState<{ anchorId: string; focusId: string } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

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

  useEffect(() => {
    setLoading(true);
    setSlash(null);
    history.current = { past: [], future: [], present: null, lastKey: null, lastTime: 0 };
    api
      .getDocument(docId)
      .then((d) => {
        titleRef.current = d.title ?? "";
        blocksRef.current = blocksFromBody(d.body);
        setLoading(false);
        bump();
      })
      .catch((e) => onError(String(e.message)));
    return () => clearTimeout(saveTimer.current);
  }, [docId]);

  const scheduleSave = () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 700);
  };
  const save = () =>
    api
      .updateDocument(docId, { title: titleRef.current, body: bodyFromBlocks(blocksRef.current) })
      .then(() => onTitleChange())
      .catch((e) => onError(String(e.message)));

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
    const children = isListType(type) ? b.children : undefined;
    b.type = type;
    b.content = draft.content ?? "";
    if (type === "todo") b.checked = draft.checked ?? false;
    else delete b.checked;
    if (type === "code") b.lang = draft.lang ?? "";
    else delete b.lang;
    if (type === "numbered" && draft.start != null && draft.start > 1) b.start = draft.start;
    else delete b.start;
    if (children?.length) b.children = children;
    else delete b.children;
    bump();
    if (type !== "divider") requestAnimationFrame(() => focusBlock(id));
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

  const applyFormatCommand = (cmd: string) => {
    const link = cmd === "createLink" ? prompt("链接地址") : null;
    if (cmd === "createLink" && !link) return;
    if (cmd === "code") wrapInlineCode();
    else document.execCommand(cmd, false, link ?? undefined);
    syncFocusedBlock(blocks);
    scheduleSave();
    updateBar(setBar);
  };

  // ---- block-selection batch operations ----
  const clearSel = () => setSel(null);

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
      const flat = flattenBlocks(blocks);
      if (flat.length) setSel({ anchorId: flat[0]!.id, focusId: flat[flat.length - 1]!.id });
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
    // let interactive affordances (gutter buttons, popovers, form controls) work
    if (target.closest(".gutter") || target.closest(".pop") || target.closest("input, button, select, a")) return;

    const blockEl = closestBlockElement(e.target as Node);
    const id = blockEl?.getAttribute("data-bid") ?? null;
    if (!id) { clearSel(); return; }

    if (e.shiftKey && sel) { // shift-click extends the current block selection
      e.preventDefault();
      enterBlockSelecting();
      setSel({ anchorId: sel.anchorId, focusId: id });
      return;
    }

    const inEditable = !!target.closest(".editable, .code-input");
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

  const onKeyDown = (e: KeyboardEvent, b: Block, el: HTMLElement) => {
    if (slash && slash.blockId === b.id) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlash({ ...slash, idx: Math.min(slash.idx + 1, slashMatches.length - 1) }); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlash({ ...slash, idx: Math.max(slash.idx - 1, 0) }); return; }
      if (e.key === "Enter") { e.preventDefault(); const m = slashMatches[slash.idx]; if (m) applySlash(m); return; }
      if (e.key === "Escape") { setSlash(null); return; }
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
    if (e.key === " " && b.type === "p" && !hasExpandedSelection()) {
      const shortcut = shortcutFromInput((el.textContent ?? "") + " ", " ");
      if (shortcut) {
        e.preventDefault();
        applyShortcut(b, shortcut);
        return;
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
      insertAfter(b.id, isListType(b.type) ? b.type : "p");
    } else if (e.key === "Backspace" && (el.textContent ?? "") === "") {
      e.preventDefault();
      if (b.type !== "p") convert(b.id, "p");
      else {
        const prev = previousBlock(blocks, b.id);
        if (prev) { remove(b.id); requestAnimationFrame(() => focusBlock(prev.id, true)); }
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
    const numbers = computeListNumbers(items);
    return items.map((b) => (
      <BlockRow
        key={b.id}
        renderKey={version}
        block={b}
        depth={depth}
        selected={selectedSet.has(b.id)}
        number={b.type === "numbered" ? (numbers.get(b.id) ?? 1) : 0}
        onInput={(el) => onContentInput(b, el)}
        onLangInput={(lang) => { b.lang = lang; bump(); scheduleSave(); }}
        onKeyDown={(e, el) => onKeyDown(e, b, el)}
        onCodeInput={(value) => { b.content = value; recordHistory("text:" + b.id); scheduleSave(); }}
        onCodeKeyDown={(e, ta) => onCodeKeyDown(e, b, ta)}
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
    <div
      class="doc"
      onMouseDown={(e) => onDocMouseDown(e as MouseEvent)}
      onMouseUp={() => updateBar(setBar)}
      onKeyUp={(e) => { if (e.shiftKey || e.key.startsWith("Arrow")) updateBar(setBar); }}
    >
      <div
        class="doc-title"
        contentEditable
        onInput={(e) => { titleRef.current = (e.target as HTMLElement).textContent ?? ""; recordHistory("title"); scheduleSave(); }}
        onBlur={() => { onTitleChange(); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (!blocks.length) insertAfter(null); else focusBlock(blocks[0]!.id); } }}
        dangerouslySetInnerHTML={{ __html: titleRef.current }}
      />
      <div class="doc-meta">
        <span><Icon name="file" cls="ico sm" />{countBlocks(blocks)} 个块</span>
        <span>实时同步</span>
      </div>

      {renderBlocks(blocks)}

      {blocks.length === 0 && (
        <div class="editable" style={{ color: "var(--muted)", cursor: "text" }} onClick={() => insertAfter(null)}>
          点此书写，或输入 “/” 选择块类型…
        </div>
      )}

      {slash && slashMatches.length > 0 && (
        <div class="pop" style={{ left: Math.min(slash.x, innerWidth - 270), top: Math.min(slash.y + 22, innerHeight - 320), minWidth: 260 }}>
          <MenuLabel>基础块</MenuLabel>
          {slashMatches.map((m, i) => (
            <button key={m.type} class={"item" + (i === slash.idx ? " sel" : "")} onMouseDown={(e) => { e.preventDefault(); applySlash(m); }}>
              <span class="lico"><Icon name={m.ic} cls="ico sm" /></span>
              <span class="meta"><span class="t">{m.t}</span><span class="d">{m.d}</span></span>
            </button>
          ))}
        </div>
      )}

      {bar && !sel && <FormatBar x={bar.x} y={bar.y} onCommand={applyFormatCommand} />}
    </div>
  );
}

function BlockRow({
  block, number, depth, renderKey, selected, onInput, onLangInput, onKeyDown, onCodeInput, onCodeKeyDown, onAdd, onMenu, onToggle, dragRef, onReorder, children,
}: {
  block: Block;
  number: number;
  depth: number;
  renderKey: number;
  selected: boolean;
  onInput: (el: HTMLElement) => void;
  onLangInput: (lang: string) => void;
  onKeyDown: (e: KeyboardEvent, el: HTMLElement) => void;
  onCodeInput: (value: string) => void;
  onCodeKeyDown: (e: KeyboardEvent, ta: HTMLTextAreaElement) => void;
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
                onInput={(e) => onInput(e.currentTarget as HTMLElement)}
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

function placeholder(t: BlockType): string {
  return ({ h1: "标题 1", h2: "标题 2", h3: "标题 3", code: "输入代码…", quote: "引用" } as Record<string, string>)[t] ?? "输入文本，“/” 唤出命令";
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

function makeBlock(type: BlockType, draft: Partial<BlockDraft> = {}): Block {
  const block: Block = { id: genId(), type, content: draft.content ?? "" };
  if (type === "todo") block.checked = draft.checked ?? false;
  if (type === "code") block.lang = draft.lang ?? "";
  if (type === "numbered" && draft.start != null && draft.start > 1) block.start = draft.start;
  if (isListType(type) && draft.children?.length) block.children = draft.children;
  return block;
}

function blockEditorText(_block: Block, el: HTMLElement): string {
  return htmlToInline(el.innerHTML);
}

function hasExpandedSelection(): boolean {
  const sel = getSelection();
  return !!sel && !sel.isCollapsed;
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
  if (atEnd) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  }
}
function clearBlockDrop() {
  document.querySelectorAll(".block.drop-before,.block.drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
}
function markBlockDrop(el: HTMLElement, e: DragEvent) {
  clearBlockDrop();
  const r = el.getBoundingClientRect();
  el.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
}
