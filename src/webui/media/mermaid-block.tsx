/** @jsxImportSource preact */
import { flushSync } from "preact/compat";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { mount, PeleError, type Mounted } from "pele";
import { t } from "../i18n/t";
import { Icon } from "../icons";
import { consumeKey, imeGhost } from "../keys";
import { CodeEditorBody, CodeLanguagePicker, CopyCodeButton, type CodeIsland } from "./code-block";

// Each CodeMirror widget has its own Preact root. ARIA IDs span all roots.
let nextSourceId = 0;

function MermaidPreview({ source, locate }: { source: string; locate: (line: number, column: number) => void }) {
  const canvas = useRef<HTMLDivElement>(null);
  const diagram = useRef<Mounted>();
  const [error, setError] = useState<unknown>(undefined);
  const empty = !source.trim();

  useLayoutEffect(() => {
    if (empty) return;
    const mounted = mount(canvas.current!, source, {
      images: false, links: false,
      zoom: { labels: { zoomIn: t("放大"), zoomOut: t("缩小"), reset: t("重置") } },
      onError: setError, onRender: () => setError(undefined),
    });
    diagram.current = mounted;
    setError(mounted.error);
    return () => { mounted.destroy(); diagram.current = undefined; };
  }, [empty]);

  // The editor writes through to Markdown on input. Only the layout work waits
  // for a short pause, and an unfinished expression keeps the last valid SVG.
  useLayoutEffect(() => {
    const mounted = diagram.current;
    if (!mounted || mounted.source === source) return;
    const timer = setTimeout(() => {
      mounted.update(source);
      setError(mounted.error);
    }, 150);
    return () => clearTimeout(timer);
  }, [source]);

  const problem = error instanceof PeleError ? error : null;
  return <>
    <div class="mermaid-figure">
      {empty
        ? <p class="mermaid-empty">{t("输入 Mermaid 源码即可预览图表。")}</p>
        : <div class="mermaid-preview" ref={canvas} />}
    </div>
    {!empty && error != null && <div class="mermaid-error" role="status">
      <Icon name="alert" cls="ico sm" />
      <span title={error instanceof Error ? error.message : undefined}>
        {problem?.code === "unsupported-diagram" ? t("未识别图表类型，请检查首行。")
          : problem?.code === "limit" ? t("图表过大，请精简源码。")
          : t("无法绘制图表，请检查源码。")}
        {diagram.current?.result && " " + t("当前显示上次有效的预览。")}
      </span>
      {problem && problem.line > 0 && <button type="button" onClick={() => locate(problem.line, problem.column)}>
        {t("第 {n} 行", { n: problem.line })}
      </button>}
    </div>}
  </>;
}

export function MermaidIsland({ code, lang, selected, onInput, onLang, onKeyDown,
  onCompositionStart, onCompositionEnd }: Parameters<typeof CodeIsland>[0]) {
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState(code);
  const composing = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [sourceId] = useState(() => `mh-mermaid-source-${++nextSourceId}`);

  function openSource(line = 1, column = 1) {
    // Mount and focus during the original tap (also opens the iOS keyboard).
    flushSync(() => setEditing(true));
    const ta = input.current!;
    const lines = ta.value.split("\n");
    const row = Math.min(line, lines.length) - 1;
    const at = lines.slice(0, row).reduce((n, s) => n + s.length + 1, 0)
      + Math.min(Math.max(0, column - 1), lines[row]!.length);
    ta.focus();
    ta.setSelectionRange(at, at);
  }
  function closeSource() {
    // Let a pending IME commit reach CodeHost before removing the textarea.
    toggle.current?.focus();
    setEditing(false);
  }
  return <div class={"mermaid-block" + (selected ? " ci-selected" : "")}>
    <div class="mermaid-bar">
      <span class="mermaid-label"><Icon name="relation" cls="ico" />
        {editing ? <CodeLanguagePicker lang={lang ?? "mermaid"} onLang={onLang} /> : "Mermaid"}
      </span>
      {editing && <CopyCodeButton getCode={() => input.current?.value ?? source} />}
      <button type="button" ref={toggle} class="mermaid-edit" aria-expanded={editing} aria-controls={sourceId}
        onClick={() => editing ? closeSource() : openSource()}>
        <Icon name={editing ? "check" : "code"} cls="ico sm" />
        {editing ? t("完成") : t("编辑源码")}
      </button>
    </div>
    <div class={"mermaid-panes" + (editing ? " is-editing" : "")}>
      <div id={sourceId} class="mermaid-source" hidden={!editing}>
        {editing && <CodeEditorBody code={source} taRef={input} ariaLabel={t("Mermaid 源码")}
          placeholder={'flowchart LR\n  A --> B'}
          onInput={(text) => {
            onInput(text);
            if (!composing.current) setSource(text);
          }}
          onCompositionStart={() => { composing.current = true; onCompositionStart?.(); }}
          onCompositionEnd={(text) => {
            composing.current = false;
            onCompositionEnd?.(text);
            setSource(text);
          }}
          onKeyDown={(e) => {
            if (!imeGhost(e) && e.key === "Escape") { consumeKey(e); closeSource(); }
            else onKeyDown?.(e);
          }}
        />}
      </div>
      <MermaidPreview source={source} locate={openSource} />
    </div>
  </div>;
}
