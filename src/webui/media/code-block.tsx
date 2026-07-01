/** @jsxImportSource preact */
// Hosts a fenced code block for the CM6 void widget: a read-only, highlighted
// display of the source. The raw code isn't edited here — the widget reveals the
// underlying CodeMirror text for editing (reveal-to-edit) and this component only
// mirrors the highlighted result, plus the language picker and copy button.
import { useState } from "preact/hooks";
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
 * Read-only render of a fenced code block: the same visual structure as the
 * editor's CodeBlock (gutter + highlighted mirror + tools bar) minus the
 * editable textarea. The language <select> is inert when `onLang` is omitted.
 */
export function CodeDisplay({
  code, lang, onLang,
}: {
  code: string;
  lang?: string;
  onLang?: (lang: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const lineCount = code.split("\n").length;
  let gutter = "1";
  for (let i = 2; i <= lineCount; i++) gutter += "\n" + i;

  const langVal = lang ?? "";
  const langKnown = COMMON_LANGS.some((l) => l.id === langVal);

  return (
    <div class="codeblock">
      <div class="code-body">
        <div class="code-gutter" aria-hidden="true">{gutter}</div>
        <div class="code-scroll">
          <pre class="code-hl"><code class="hljs" dangerouslySetInnerHTML={{ __html: highlightCode(code, lang) }} /></pre>
        </div>
      </div>
      <div class="code-tools">
        <span class="code-lang">
          <select
            value={langVal}
            disabled={!onLang}
            onChange={(e) => onLang?.((e.currentTarget as HTMLSelectElement).value)}
          >
            {!langKnown && <option value={langVal}>{langVal || "纯文本"}</option>}
            {COMMON_LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          <Icon name="chevronDown" cls="ico sm" />
        </span>
        <button
          class={"code-copy" + (copied ? " ok" : "")}
          title="复制代码"
          onClick={() => {
            navigator.clipboard?.writeText(code)
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
