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
  blocksFromBody,
  bodyFromBlocks,
  genId,
  isListType,
  shortcutFromInput,
} from "./blocks.ts";
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
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  const bump = () => setVersion((v) => v + 1);

  useEffect(() => {
    setLoading(true);
    setSlash(null);
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
    if (children?.length) b.children = children;
    else delete b.children;
    bump();
    if (type !== "divider") requestAnimationFrame(() => focusBlock(id));
    scheduleSave();
  };

  const remove = (id: string) => {
    const found = findBlock(blocks, id);
    if (!found) return;
    found.parent.splice(found.index, 1);
    bump();
    scheduleSave();
  };

  const onContentInput = (b: Block, el: HTMLElement) => {
    b.content = blockEditorText(b, el);
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
    const found = findBlock(blocks, id);
    if (!found || found.index === 0) return;
    const previous = found.parent[found.index - 1]!;
    if (!isListType(previous.type)) return;
    const moved = found.parent.splice(found.index, 1)[0]!;
    previous.children ??= [];
    previous.children.push(moved);
    bump();
    requestAnimationFrame(() => focusBlock(id));
    scheduleSave();
  };

  const outdent = (id: string) => {
    const found = findBlock(blocks, id);
    if (!found?.parentBlock) return;
    const parentFound = findBlock(blocks, found.parentBlock.id);
    if (!parentFound) return;
    const moved = found.parent.splice(found.index, 1)[0]!;
    if (found.parent.length === 0) delete found.parentBlock.children;
    parentFound.parent.splice(parentFound.index + 1, 0, moved);
    bump();
    requestAnimationFrame(() => focusBlock(id));
    scheduleSave();
  };

  const onKeyDown = (e: KeyboardEvent, b: Block, el: HTMLElement) => {
    if (slash && slash.blockId === b.id) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlash({ ...slash, idx: Math.min(slash.idx + 1, slashMatches.length - 1) }); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlash({ ...slash, idx: Math.max(slash.idx - 1, 0) }); return; }
      if (e.key === "Enter") { e.preventDefault(); const m = slashMatches[slash.idx]; if (m) applySlash(m); return; }
      if (e.key === "Escape") { setSlash(null); return; }
    }
    if (e.key === "Tab" && (b.type === "code" || isListType(b.type))) {
      e.preventDefault();
      if (b.type === "code") document.execCommand("insertText", false, "  ");
      else (e.shiftKey ? outdent : indent)(b.id);
      return;
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

  const renderBlocks = (items: Block[], depth = 0): ComponentChildren =>
    items.map((b, i) => (
      <BlockRow
        key={b.id}
        renderKey={version}
        block={b}
        depth={depth}
        number={b.type === "numbered" ? items.slice(0, i + 1).filter((x) => x.type === "numbered").length : 0}
        onInput={(el) => onContentInput(b, el)}
        onLangInput={(lang) => { b.lang = lang; bump(); scheduleSave(); }}
        onKeyDown={(e, el) => onKeyDown(e, b, el)}
        onCodeInput={(value) => { b.content = value; scheduleSave(); }}
        onCodeKeyDown={(e, ta) => onCodeKeyDown(e, b, ta)}
        onAdd={() => insertAfter(b.id)}
        onMenu={(e) => blockMenu(e, b)}
        onToggle={() => { b.checked = !b.checked; bump(); scheduleSave(); }}
        dragRef={dragRef}
        onReorder={(srcId, where) => {
          if (moveBlock(blocks, srcId, b.id, where)) {
            bump();
            scheduleSave();
          }
        }}
      >
        {b.children?.length ? renderBlocks(b.children, depth + 1) : null}
      </BlockRow>
    ));

  return (
    <div
      class="doc"
      onMouseUp={() => updateBar(setBar)}
      onKeyUp={(e) => { if (e.shiftKey || e.key.startsWith("Arrow")) updateBar(setBar); }}
    >
      <div
        class="doc-title"
        contentEditable
        onInput={(e) => { titleRef.current = (e.target as HTMLElement).textContent ?? ""; scheduleSave(); }}
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

      {bar && <FormatBar x={bar.x} y={bar.y} onDone={() => syncFocusedBlock(blocksRef.current)} />}
    </div>
  );
}

function BlockRow({
  block, number, depth, renderKey, onInput, onLangInput, onKeyDown, onCodeInput, onCodeKeyDown, onAdd, onMenu, onToggle, dragRef, onReorder, children,
}: {
  block: Block;
  number: number;
  depth: number;
  renderKey: number;
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
  useEffect(() => {
    if (edRef.current && block.type !== "code") edRef.current.innerHTML = inlineToHtml(block.content);
  }, [renderKey, block.type]);
  const compactCodeHost =
    isListType(block.type) && block.content.trim() === "" && block.children?.[0]?.type === "code";
  const cls =
    "block b-" +
    block.type +
    (block.type === "todo" && block.checked ? " b-done" : "") +
    (compactCodeHost ? " list-code-host" : "");
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
function FormatBar({ x, y, onDone }: { x: number; y: number; onDone: () => void }) {
  const run = (cmd: string) => (e: MouseEvent) => {
    e.preventDefault();
    if (cmd === "code") wrapInlineCode();
    else if (cmd === "createLink") { const u = prompt("链接地址"); if (u) document.execCommand("createLink", false, u); }
    else document.execCommand(cmd, false);
    onDone();
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
function updateBar(setBar: (b: { x: number; y: number } | null) => void) {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return setBar(null);
  const node = sel.anchorNode;
  if (!(node?.parentElement?.closest?.(".editable"))) return setBar(null);
  const r = sel.getRangeAt(0).getBoundingClientRect();
  if (!r.width) return setBar(null);
  setBar({ x: r.left, y: r.top });
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
  if (isListType(type) && draft.children?.length) block.children = draft.children;
  return block;
}

interface FoundBlock {
  block: Block;
  parent: Block[];
  index: number;
  parentBlock: Block | null;
}

function findBlock(blocks: Block[], id: string, parentBlock: Block | null = null): FoundBlock | null {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.id === id) return { block, parent: blocks, index: i, parentBlock };
    const found = block.children ? findBlock(block.children, id, block) : null;
    if (found) return found;
  }
  return null;
}

function countBlocks(blocks: readonly Block[]): number {
  let count = 0;
  for (const block of blocks) count += 1 + countBlocks(block.children ?? []);
  return count;
}

function cloneBlock(block: Block): Block {
  return {
    ...block,
    id: genId(),
    children: block.children?.map(cloneBlock),
  };
}

function containsBlock(blocks: readonly Block[] | undefined, id: string): boolean {
  for (const block of blocks ?? []) {
    if (block.id === id || containsBlock(block.children, id)) return true;
  }
  return false;
}

function moveBlock(blocks: Block[], srcId: string, targetId: string, where: "before" | "after"): boolean {
  if (srcId === targetId) return false;
  const source = findBlock(blocks, srcId);
  const target = findBlock(blocks, targetId);
  if (!source || !target || containsBlock(source.block.children, targetId)) return false;

  const moved = source.parent.splice(source.index, 1)[0]!;
  const freshTarget = findBlock(blocks, targetId);
  if (!freshTarget) {
    source.parent.splice(source.index, 0, moved);
    return false;
  }
  freshTarget.parent.splice(freshTarget.index + (where === "after" ? 1 : 0), 0, moved);
  return true;
}

function previousBlock(blocks: readonly Block[], id: string): Block | null {
  let previous: Block | null = null;
  let found: Block | null = null;
  const visit = (items: readonly Block[]) => {
    for (const block of items) {
      if (block.id === id) {
        found = previous;
        return;
      }
      previous = block;
      if (block.children) visit(block.children);
      if (found) return;
    }
  };
  visit(blocks);
  return found;
}

function flatten(blocks: readonly Block[], out: Block[] = []): Block[] {
  for (const block of blocks) {
    out.push(block);
    if (block.children) flatten(block.children, out);
  }
  return out;
}

function nextBlock(blocks: readonly Block[], id: string): Block | null {
  const flat = flatten(blocks);
  const i = flat.findIndex((b) => b.id === id);
  return i >= 0 && i + 1 < flat.length ? flat[i + 1]! : null;
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
