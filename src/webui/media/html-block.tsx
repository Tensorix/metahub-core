/** @jsxImportSource preact */
// A block that renders raw HTML. The markup runs inside a sandboxed <iframe
// srcdoc> with `allow-scripts` but NOT `allow-same-origin`, so scripts execute in
// a null origin: they can't read the app's cookies / storage / DOM, and the
// embedded CSS can't leak into the editor. Height auto-fits via a postMessage
// reporter injected into the srcdoc. Source serializes to a ```mh-html fence.
import { useEffect, useRef, useState } from "preact/hooks";
import type { Block } from "../blocks.ts";
import { Icon } from "../icons.tsx";

const REPORTER = `<script>(function(){function r(){try{parent.postMessage({__mhHtmlHeight:document.documentElement.scrollHeight},'*')}catch(e){}}try{new ResizeObserver(r).observe(document.documentElement)}catch(e){}addEventListener('load',r);setTimeout(r,60);setTimeout(r,400)})();<\/script>`;

function srcdoc(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;padding:0;color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif}</style></head><body>${html}${REPORTER}</body></html>`;
}

export function HtmlBlock({
  block,
  selected,
  onChange,
}: {
  block: Block;
  selected: boolean;
  onChange: (content: string) => void;
}) {
  const [editing, setEditing] = useState(!block.content.trim());
  const [height, setHeight] = useState(120);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Land the caret in the source as soon as the block enters edit mode.
  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  // Auto-height: the injected reporter posts its scrollHeight; match only our own
  // frame (no same-origin, so compare the source window).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (frameRef.current && e.source === frameRef.current.contentWindow) {
        const h = Number((e.data as { __mhHtmlHeight?: number })?.__mhHtmlHeight);
        if (h > 0) setHeight(Math.max(48, Math.min(Math.ceil(h), 4000)));
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  return (
    <div class={"void-block void-html" + (selected ? " selected" : "")}>
      <div class="html-bar">
        <span class="html-tag"><Icon name="htmlTag" cls="ico sm" /> HTML</span>
        <button
          class={"html-toggle" + (editing ? " on" : "")}
          title={editing ? "预览渲染" : "编辑源码"}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setEditing((v) => !v)}
        >
          <Icon name={editing ? "eye" : "code"} cls="ico sm" />
          <span>{editing ? "预览" : "源码"}</span>
        </button>
      </div>
      {editing ? (
        <textarea
          ref={taRef}
          class="html-source code-input"
          spellcheck={false}
          placeholder="<!-- 在此粘贴 / 编写 HTML，将沙箱渲染 -->"
          value={block.content}
          onMouseDown={(e) => e.stopPropagation()}
          onInput={(e) => onChange((e.currentTarget as HTMLTextAreaElement).value)}
        />
      ) : block.content.trim() ? (
        <iframe
          ref={frameRef}
          class="html-frame"
          title="HTML 预览"
          sandbox="allow-scripts allow-popups"
          srcdoc={srcdoc(block.content)}
          style={{ height: `${height}px` }}
        />
      ) : (
        <div class="html-empty" onClick={() => setEditing(true)}>
          空的 HTML 块 — 点此添加内容
        </div>
      )}
    </div>
  );
}
