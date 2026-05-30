/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { Icon } from "./icons.tsx";
import { openMenu, MenuItem, MenuLabel, MenuSep } from "./ui.tsx";
import {
  type Block,
  type BlockType,
  BLOCK_MENU,
  blocksFromBody,
  bodyFromBlocks,
  genId,
} from "./blocks.ts";
import { inlineToHtml, htmlToInline } from "./markdown.tsx";

const LIST_TYPES: BlockType[] = ["bullet", "numbered", "todo"];

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
  const idx = (id: string) => blocks.findIndex((b) => b.id === id);

  const insertAfter = (afterId: string | null, type: BlockType = "p"): Block => {
    const b: Block = { id: genId(), type, content: "" };
    const i = afterId ? idx(afterId) : -1;
    blocks.splice(i + 1, 0, b);
    bump();
    requestAnimationFrame(() => focusBlock(b.id));
    scheduleSave();
    return b;
  };

  const convert = (id: string, type: BlockType) => {
    const b = blocks[idx(id)];
    if (!b) return;
    b.type = type;
    b.content = "";
    if (type !== "todo") delete b.checked;
    bump();
    if (type !== "divider") requestAnimationFrame(() => focusBlock(id));
    scheduleSave();
  };

  const remove = (id: string) => {
    const i = idx(id);
    if (i < 0) return;
    blocks.splice(i, 1);
    bump();
    scheduleSave();
  };

  const onContentInput = (b: Block, el: HTMLElement) => {
    b.content = htmlToInline(el.innerHTML);
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

  const onKeyDown = (e: KeyboardEvent, b: Block, el: HTMLElement) => {
    if (slash && slash.blockId === b.id) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlash({ ...slash, idx: Math.min(slash.idx + 1, slashMatches.length - 1) }); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlash({ ...slash, idx: Math.max(slash.idx - 1, 0) }); return; }
      if (e.key === "Enter") { e.preventDefault(); const m = slashMatches[slash.idx]; if (m) applySlash(m); return; }
      if (e.key === "Escape") { setSlash(null); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && b.type !== "code") {
      e.preventDefault();
      const empty = (el.textContent ?? "").trim() === "";
      if (LIST_TYPES.includes(b.type) && empty) { convert(b.id, "p"); return; }
      insertAfter(b.id, LIST_TYPES.includes(b.type) ? b.type : "p");
    } else if (e.key === "Backspace" && (el.textContent ?? "") === "") {
      e.preventDefault();
      const i = idx(b.id);
      if (b.type !== "p") convert(b.id, "p");
      else if (i > 0) { const prev = blocks[i - 1]!; remove(b.id); requestAnimationFrame(() => focusBlock(prev.id, true)); }
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
        <MenuItem icon="copy" label="复制块" onClick={() => { const i = idx(b.id); blocks.splice(i + 1, 0, { ...b, id: genId() }); bump(); scheduleSave(); close(); }} />
        <MenuItem icon="trash" label="删除块" danger onClick={() => { remove(b.id); close(); }} />
      </>
    ));
  };

  // drag reorder
  const dragRef = useRef<string | null>(null);

  if (loading) return <div class="empty">加载中…</div>;

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
        <span><Icon name="file" cls="ico sm" />{blocks.length} 个块</span>
        <span>实时同步</span>
      </div>

      {blocks.map((b) => (
        <BlockRow
          key={b.id}
          renderKey={version}
          block={b}
          number={b.type === "numbered" ? blocks.filter((x) => x.type === "numbered" && idx(x.id) <= idx(b.id)).length : 0}
          onInput={(el) => onContentInput(b, el)}
          onKeyDown={(e, el) => onKeyDown(e, b, el)}
          onAdd={() => insertAfter(b.id)}
          onMenu={(e) => blockMenu(e, b)}
          onToggle={() => { b.checked = !b.checked; bump(); scheduleSave(); }}
          dragRef={dragRef}
          onReorder={(srcId, where) => {
            const from = idx(srcId);
            if (from < 0 || srcId === b.id) return;
            const moved = blocks.splice(from, 1)[0]!;
            let to = idx(b.id);
            if (where === "after") to += 1;
            blocks.splice(to, 0, moved);
            bump();
            scheduleSave();
          }}
        />
      ))}

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
  block, number, renderKey, onInput, onKeyDown, onAdd, onMenu, onToggle, dragRef, onReorder,
}: {
  block: Block;
  number: number;
  renderKey: number;
  onInput: (el: HTMLElement) => void;
  onKeyDown: (e: KeyboardEvent, el: HTMLElement) => void;
  onAdd: () => void;
  onMenu: (e: MouseEvent) => void;
  onToggle: () => void;
  dragRef: { current: string | null };
  onReorder: (srcId: string, where: "before" | "after") => void;
}) {
  const edRef = useRef<HTMLDivElement>(null);
  // Uncontrolled: set innerHTML only on structural changes (renderKey/type), not
  // on every re-render, so typing — including a `/` query that re-renders the
  // doc to show the slash menu — never resets the caret.
  useEffect(() => {
    if (edRef.current) edRef.current.innerHTML = inlineToHtml(block.content);
  }, [renderKey, block.type]);
  const cls = "block b-" + block.type + (block.type === "todo" && block.checked ? " b-done" : "");
  return (
    <div
      class={cls}
      data-bid={block.id}
      onDragOver={(e) => { if (dragRef.current && dragRef.current !== block.id) { e.preventDefault(); markBlockDrop(e.currentTarget as HTMLElement, e); } }}
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
          onDragStart={(e) => { dragRef.current = block.id; (e.currentTarget!.closest(".block") as HTMLElement).classList.add("dragging"); }}
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
          <div
            ref={edRef}
            class="editable"
            contentEditable
            data-ph={placeholder(block.type)}
            onInput={(e) => onInput(e.currentTarget as HTMLElement)}
            onKeyDown={(e) => onKeyDown(e, e.currentTarget as HTMLElement)}
          />
        </>
      )}
    </div>
  );
}

function placeholder(t: BlockType): string {
  return ({ h1: "标题 1", h2: "标题 2", h3: "标题 3", code: "输入代码…", quote: "引用" } as Record<string, string>)[t] ?? "输入文本，“/” 唤出命令";
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
  const b = blocks.find((x) => x.id === id);
  if (b && el) b.content = htmlToInline(el.innerHTML);
}

// ---- caret + drag helpers ----
function caretRect(): { x: number; y: number } {
  const sel = getSelection();
  if (!sel || !sel.rangeCount) return { x: 80, y: 120 };
  const r = sel.getRangeAt(0).getBoundingClientRect();
  return { x: r.left || 80, y: r.top || 120 };
}
function focusBlock(id: string, atEnd = false) {
  const el = document.querySelector(`.block[data-bid="${id}"] .editable`) as HTMLElement | null;
  if (!el) return;
  el.focus();
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
  document.querySelectorAll(".drop-before,.drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
}
function markBlockDrop(el: HTMLElement, e: DragEvent) {
  clearBlockDrop();
  const r = el.getBoundingClientRect();
  el.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
}
