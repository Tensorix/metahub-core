/** @jsxImportSource preact */
// The code island for the CM6 void widget: a fenced code block that stays a
// rendered, highlighted component even while being edited. Editing uses the
// classic transparent-textarea-over-hljs-mirror technique (CodeEditorBody); the
// language picker and copy button live in the absolutely-positioned bottom-right
// tools pill (hover-revealed; hidden while editing or block-selected so it never
// covers the editing area), so the block's height never changes and the widget
// never degrades to raw source text.
import { useEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import hljs from "highlight.js/lib/common";
import { COMMON_LANGS } from "../blocks.ts";
import { formatCode } from "../fmt/format.ts";
import { canFormat } from "../fmt/lang-map.ts";
import { Icon } from "../icons.tsx";
import { escapeHtml } from "../markdown.tsx";
import { applyTaEdit, formatTaEdit } from "./code-edit.ts";

/** Highlight code to HTML for the overlay layer. A known language is highlighted;
 *  no/unknown language falls back to escaped plain text rather than hljs's
 *  all-language `highlightAuto` probe, which is expensive to run on every repaint
 *  (and often guesses wrong). Set a language on the block to get highlighting. */
export function highlightCode(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang))
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    return escapeHtml(code);
  } catch {
    return escapeHtml(code);
  }
}

/**
 * Highlight code and split the HTML into one fragment per logical line, closing
 * open hljs spans at each newline and re-opening them on the next line (a token
 * like a template string can span lines). Per-line fragments let the mirror
 * render each logical line as its own block, so soft-wrapped lines get their
 * true height and the CSS-counter line numbers stay aligned to logical lines.
 */
export function highlightCodeLines(code: string, lang?: string): string[] {
  const root = document.createElement("div");
  root.innerHTML = highlightCode(code, lang);
  const lines: string[] = [];
  const open: string[] = [];
  let cur = "";
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.nodeValue ?? "").split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          lines.push(cur + "</span>".repeat(open.length));
          cur = open.join("");
        }
        cur += escapeHtml(parts[i]!);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // hljs emits only <span class>; anything else degrades to a span too
      const tag = `<span class="${(node as Element).className}">`;
      cur += tag;
      open.push(tag);
      node.childNodes.forEach(visit);
      open.pop();
      cur += "</span>";
    }
  };
  root.childNodes.forEach(visit);
  lines.push(cur);
  return lines;
}

// Global soft-wrap preference for all code editors: a device-level toggle
// (tools-pill button), persisted in localStorage, default off. A DOM event
// fans the change out to every mounted editor — they are separate Preact roots.
const WRAP_KEY = "mh:code-wrap";
const WRAP_EVT = "mh-code-wrap-change";
function wrapPref(): boolean {
  try { return localStorage.getItem(WRAP_KEY) === "1"; } catch { return false; }
}
function setWrapPref(on: boolean) {
  try { localStorage.setItem(WRAP_KEY, on ? "1" : "0"); } catch {}
  document.dispatchEvent(new Event(WRAP_EVT));
}
function useWrapPref(): boolean {
  const [on, setOn] = useState(wrapPref);
  useEffect(() => {
    const h = () => setOn(wrapPref());
    document.addEventListener(WRAP_EVT, h);
    return () => document.removeEventListener(WRAP_EVT, h);
  }, []);
  return on;
}

/**
 * The editing core shared by the code island and the HTML source editor: a
 * transparent `textarea.code-input` stacked over an absolutely-positioned
 * highlighted `pre.code-hl` mirror. By default long lines don't wrap — the
 * textarea scrolls horizontally and mirrors its scrollLeft onto the highlight
 * layer. With the global wrap preference on, both layers soft-wrap (shared
 * pre-wrap + break-word, so their wrap points match); the mirror renders one
 * `.code-hl-line` block per logical line, and line numbers switch from the
 * flex gutter to CSS counters on those blocks — a wrapped line grows its
 * block, the numbers stay aligned to logical lines for free. Uncontrolled like
 * the old editor's CodeBlock — the textarea owns the text while focused; the
 * `code` prop is only pushed in when it differs (external rebuilds recreate
 * the whole component anyway).
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
  const wrap = useWrapPref();
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const hlRef = useRef<HTMLElement>(null);
  const gutRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const paintRaf = useRef<number | null>(null);
  const prevLineCount = useRef(-1);

  const setTa = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (taRef) taRef.current = el;
  };

  // Repaint the highlight mirror (one block per logical line) + the line
  // numbers of whichever gutter the current mode shows (flex column / CSS
  // counters sized by --code-ln-ch), and grow the textarea to fit its content
  // (so the block has no inner vertical scroll).
  // Re-highlight the mirror + line numbers. The highlight (detached-DOM parse +
  // tree walk) is the expensive part, so it's coalesced to one run per animation
  // frame (see `paint`); the gutter/`--code-ln-ch` only rebuild when the line
  // count actually changes.
  const paintHighlight = (value: string) => {
    if (!hlRef.current) return;
    const lines = highlightCodeLines(value, lang);
    hlRef.current.innerHTML = lines
      .map((h) => `<div class="code-hl-line">${h}</div>`)
      .join("");
    if (lines.length !== prevLineCount.current) {
      prevLineCount.current = lines.length;
      bodyRef.current?.style.setProperty("--code-ln-ch", `${String(lines.length).length}ch`);
      if (gutRef.current) {
        let s = "1";
        for (let i = 2; i <= lines.length; i++) s += "\n" + i;
        gutRef.current.textContent = s;
      }
    }
  };

  const paint = (value: string) => {
    // Coalesce highlight repaints so a burst of keystrokes doesn't re-highlight
    // on every key — the textarea (source of truth) stays instant; a brief
    // unhighlighted flash between frames is acceptable.
    if (typeof requestAnimationFrame === "undefined") {
      paintHighlight(value);
    } else {
      if (paintRaf.current != null) cancelAnimationFrame(paintRaf.current);
      paintRaf.current = requestAnimationFrame(() => {
        paintRaf.current = null;
        paintHighlight(value);
      });
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

  // Soft wrap makes content height depend on width: re-fit the textarea when
  // the block gets narrower/wider (window resize, sidebar toggle). Width-gated
  // so the observer doesn't react to its own height writes.
  useEffect(() => {
    const ta = innerRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    let lastW = ta.clientWidth;
    const ro = new ResizeObserver(() => {
      if (ta.clientWidth === lastW) return;
      lastW = ta.clientWidth;
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, []);

  // Toggling wrap reflows the text: re-fit the height and drop any leftover
  // horizontal scroll offset on both layers.
  useEffect(() => {
    const ta = innerRef.current;
    if (!ta) return;
    ta.scrollLeft = 0;
    const pre = hlRef.current?.parentElement;
    if (pre) pre.scrollLeft = 0;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, [wrap]);

  // Drop any pending coalesced highlight when the block unmounts.
  useEffect(
    () => () => {
      if (paintRaf.current != null) cancelAnimationFrame(paintRaf.current);
    },
    [],
  );

  return (
    <div ref={bodyRef} class={"code-body" + (wrap ? " wrap" : "")}>
      <div ref={gutRef} class="code-gutter" aria-hidden="true">1</div>
      <div class="code-scroll">
        <pre class="code-hl" aria-hidden="true"><code ref={hlRef} class="hljs" /></pre>
        <textarea
          ref={setTa}
          class="code-input"
          rows={1}
          spellcheck={false}
          wrap={wrap ? "soft" : "off"}
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
 * The always-editable code block widget: CodeEditorBody plus the language
 * picker + copy button in the bottom-right tools pill. The pill is an absolute
 * overlay revealed on hover only while the island is neither focused nor
 * block-selected (it would cover the editing area otherwise), so showing it
 * never changes the block's height (no layout shift when clicking into the code).
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
  const wrap = useWrapPref();
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

  // 格式化 button state: transient ok/err flashes mirror the copy button.
  const [fmtState, setFmtState] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const fmtErr = useRef("");
  const fmtTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashFmt = (s: "ok" | "err") => {
    setFmtState(s);
    clearTimeout(fmtTimer.current);
    fmtTimer.current = setTimeout(() => setFmtState("idle"), s === "err" ? 2400 : 1400);
  };
  useEffect(() => () => clearTimeout(fmtTimer.current), []);

  const runFormat = async () => {
    const ta = localTa.current;
    if (!ta || fmtState === "busy" || !canFormat(langVal)) return;
    const value = ta.value;
    const cursor = ta.selectionStart ?? value.length;
    setFmtState("busy");
    try {
      const r = await formatCode(value, langVal, cursor);
      // In-flight race: the user typed (or the island rebuilt) while a lazy
      // engine was loading — the result describes stale text, drop it.
      if (localTa.current !== ta || ta.value !== value) { setFmtState("idle"); return; }
      const ed = r && formatTaEdit(value, r.text, r.cursor);
      if (ed) applyTaEdit(ta, ed); // rides onInput → commit: one undo step
      flashFmt("ok");
    } catch (e) {
      fmtErr.current = String((e as Error)?.message ?? e).split("\n")[0]!;
      flashFmt("err");
    }
  };

  // Shift-Alt-F (VS Code muscle memory). e.code, not e.key: on macOS the
  // combo's e.key is "Ï". Intercepted here so CodeHost needs no changes.
  const keyDown = (e: KeyboardEvent) => {
    if (
      !e.isComposing && e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey &&
      e.code === "KeyF" && canFormat(langVal)
    ) {
      e.preventDefault();
      void runFormat();
      return;
    }
    onKeyDown?.(e);
  };

  return (
    <div class={"codeblock" + (selected ? " ci-selected" : "")}>
      <CodeEditorBody
        code={code}
        lang={langVal || undefined}
        onInput={onInput}
        onKeyDown={keyDown}
        taRef={mergedRef}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
      />
      <div class="code-tools">
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
        <button
          class={"code-wrap-btn" + (wrap ? " on" : "")}
          title={wrap ? "关闭自动换行" : "自动换行(所有代码块)"}
          aria-pressed={wrap}
          onMouseDown={(e) => e.preventDefault() /* keep textarea focus/caret */}
          onClick={() => setWrapPref(!wrap)}
        >
          <Icon name="wrapText" cls="ico sm" />
          换行
        </button>
        {canFormat(langVal) && (
          <button
            class={"code-fmt" + (fmtState === "ok" ? " ok" : fmtState === "err" ? " err" : "")}
            title={fmtState === "err" ? fmtErr.current : "格式化代码 (Shift+Alt+F)"}
            onMouseDown={(e) => e.preventDefault() /* keep textarea focus/caret */}
            onClick={() => void runFormat()}
          >
            <Icon name={fmtState === "ok" ? "check" : "wand"} cls="ico sm" />
            {fmtState === "busy" ? "格式化中…"
              : fmtState === "ok" ? "已格式化"
              : fmtState === "err" ? "失败"
              : "格式化"}
          </button>
        )}
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
