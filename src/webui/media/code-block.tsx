/** @jsxImportSource preact */
// The code island for the CM6 void widget: a fenced code block that stays a
// rendered, highlighted component even while being edited. Editing uses the
// classic transparent-textarea-over-hljs-mirror technique (CodeEditorBody); the
// island adds literal ``` fence rows (visible only while focused, via the
// .ci-fence CSS) so the user always sees "this is a fenced block" without the
// widget ever degrading to raw source text.
import { useEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import hljs from "highlight.js/lib/common";
import { COMMON_LANGS } from "../blocks.ts";
import { Icon } from "../icons.tsx";
import { escapeHtml } from "../markdown.tsx";

/** Highlight code to HTML for the overlay layer. Falls back to escaped text. */
export function highlightCode(code: string, lang?: string): string {
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

/**
 * The editing core shared by the code island and the HTML source editor: a
 * line-number gutter plus a transparent `textarea.code-input` stacked over an
 * absolutely-positioned highlighted `pre.code-hl` mirror. Uncontrolled like the
 * old editor's CodeBlock — the textarea owns the text while focused; the `code`
 * prop is only pushed in when it differs (external rebuilds recreate the whole
 * component anyway).
 */
export function CodeEditorBody({
  code, lang, onInput, onKeyDown, taRef, placeholder,
  onCompositionStart, onCompositionEnd,
}: {
  code: string;
  lang?: string;
  onInput: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  taRef?: RefObject<HTMLTextAreaElement>;
  placeholder?: string;
  onCompositionStart?: () => void;
  onCompositionEnd?: (value: string) => void;
}) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const hlRef = useRef<HTMLElement>(null);
  const gutRef = useRef<HTMLDivElement>(null);

  const setTa = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (taRef) taRef.current = el;
  };

  // Repaint the highlight mirror + line-number gutter, and grow the textarea to
  // fit its content (so the block has no inner vertical scroll).
  const paint = (value: string) => {
    if (hlRef.current) hlRef.current.innerHTML = highlightCode(value, lang);
    if (gutRef.current) {
      const lines = value.split("\n").length;
      let s = "1";
      for (let i = 2; i <= lines; i++) s += "\n" + i;
      gutRef.current.textContent = s;
    }
    const ta = innerRef.current;
    if (ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
  };

  // Push external value + repaint. Callers keep `code` in step with what the
  // user typed (bRef / parent state), so this never clobbers the caret while
  // typing; it fires for real when lang changes (re-highlight the same text).
  useEffect(() => {
    const ta = innerRef.current;
    if (ta && ta.value !== code) ta.value = code;
    paint(innerRef.current?.value ?? code);
  }, [code, lang]);

  return (
    <div class="code-body">
      <div ref={gutRef} class="code-gutter" aria-hidden="true">1</div>
      <div class="code-scroll">
        <pre class="code-hl" aria-hidden="true"><code ref={hlRef} class="hljs" /></pre>
        <textarea
          ref={setTa}
          class="code-input"
          rows={1}
          spellcheck={false}
          wrap="off"
          placeholder={placeholder ?? "输入代码…"}
          onInput={(e) => {
            const ta = e.currentTarget as HTMLTextAreaElement;
            paint(ta.value);
            onInput(ta.value);
          }}
          onKeyDown={onKeyDown ? (e) => onKeyDown(e as KeyboardEvent) : undefined}
          onCompositionStart={onCompositionStart ? () => onCompositionStart() : undefined}
          onCompositionEnd={
            onCompositionEnd
              ? (e) => onCompositionEnd((e.currentTarget as HTMLTextAreaElement).value)
              : undefined
          }
          onScroll={(e) => {
            const pre = hlRef.current?.parentElement as HTMLElement | null;
            if (pre) pre.scrollLeft = (e.currentTarget as HTMLTextAreaElement).scrollLeft;
          }}
        />
      </div>
    </div>
  );
}

/**
 * The always-editable code block widget: top fence row (literal ``` + language
 * picker) + CodeEditorBody + bottom fence row, plus the copy button in the
 * hover tools area. The fence rows live in the DOM permanently but only show
 * while the island has focus (`.cm-void-code:focus-within .ci-fence`), so the
 * reading state looks exactly like the old read-only display.
 */
export function CodeIsland({
  code, lang, selected, onInput, onLang, onKeyDown, taRef,
  onCompositionStart, onCompositionEnd,
}: {
  code: string;
  lang?: string;
  selected?: boolean;
  onInput: (value: string) => void;
  onLang: (lang: string) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  taRef?: RefObject<HTMLTextAreaElement>;
  onCompositionStart?: () => void;
  onCompositionEnd?: (value: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const localTa = useRef<HTMLTextAreaElement | null>(null);
  const mergedRef: RefObject<HTMLTextAreaElement> = {
    get current() { return localTa.current; },
    set current(el) {
      localTa.current = el;
      if (taRef) taRef.current = el;
    },
  };

  const langVal = lang ?? "";
  const langKnown = COMMON_LANGS.some((l) => l.id === langVal);

  return (
    <div class={"codeblock" + (selected ? " ci-selected" : "")}>
      <div class="ci-fence ci-fence-top">
        <span class="ci-ticks">```</span>
        <span class="code-lang">
          <select
            value={langVal}
            onChange={(e) => onLang((e.currentTarget as HTMLSelectElement).value)}
          >
            {!langKnown && <option value={langVal}>{langVal || "纯文本"}</option>}
            {COMMON_LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          <Icon name="chevronDown" cls="ico sm" />
        </span>
      </div>
      <CodeEditorBody
        code={code}
        lang={langVal || undefined}
        onInput={onInput}
        onKeyDown={onKeyDown}
        taRef={mergedRef}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
      />
      <div class="ci-fence ci-fence-bottom">
        <span class="ci-ticks">```</span>
      </div>
      <div class="code-tools">
        <button
          class={"code-copy" + (copied ? " ok" : "")}
          title="复制代码"
          onClick={() => {
            const text = localTa.current?.value ?? code;
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
