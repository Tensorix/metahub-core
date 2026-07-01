// Self-contained CM6 theme for the document editor. Styles the decoration classes
// emitted by block-deco.ts / inline.ts and, crucially, configures DOCUMENT-FLOW
// scrolling (`.cm-scroller { overflow: visible }`, no fixed height) so the editor
// grows with its content and the page scrolls — the invariant iOS 26 Safari needs
// for its glass bars to composite. Colors come from the app's CSS variables so the
// editor tracks the active theme.

import { EditorView } from "@codemirror/view";

export const editorTheme = EditorView.baseTheme({
  "&": {
    color: "var(--fg)",
    backgroundColor: "transparent",
    fontSize: "16px",
  },
  "&.cm-focused": { outline: "none" },
  // Document-flow scroll: the page scrolls, not an inner box (iOS invariant).
  ".cm-scroller": {
    overflow: "visible",
    fontFamily: "inherit",
    lineHeight: "1.65",
  },
  ".cm-content": {
    padding: "0",
    caretColor: "var(--fg)",
  },
  ".cm-line": { padding: "1px 0" },

  // Void block widgets (code / table / media / html). Spacing MUST be padding, not
  // margin — CM6 measures a block widget's height via offsetHeight, which excludes
  // margin, so a margin would desync the height map and drift caret/selection.
  ".cm-void": { padding: "6px 0" },

  // Headings — literal `# ` collapses when the caret is away (block-deco).
  ".cm-h1": { fontSize: "1.8em", fontWeight: "700", lineHeight: "1.3", margin: "0" },
  ".cm-h2": { fontSize: "1.5em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-h3": { fontSize: "1.25em", fontWeight: "600" },
  ".cm-h4": { fontSize: "1.1em", fontWeight: "600" },
  ".cm-h5": { fontSize: "1em", fontWeight: "600" },
  ".cm-h6": { fontSize: "0.95em", fontWeight: "600", color: "var(--muted)" },

  ".cm-quote": {
    borderLeft: "3px solid var(--line-strong, var(--line))",
    paddingLeft: "12px",
    color: "var(--muted)",
    fontStyle: "italic",
  },

  ".cm-divider": { position: "relative" },
  ".cm-hr": {
    display: "inline-block",
    width: "100%",
    borderBottom: "1px solid var(--line-strong, var(--line))",
    verticalAlign: "middle",
  },

  // List lines — leading whitespace hidden, indent supplied by padding-left.
  ".cm-li": { position: "relative" },
  // Bullet occupies the 24px marker gutter in-flow (the line's text-indent hangs the
  // first row; no negative margin, else it would spill past the flush-left edge).
  ".cm-bullet": { display: "inline-block", width: "24px", textAlign: "center", color: "var(--muted)" },
  ".cm-ol-num": { color: "var(--muted)", fontVariantNumeric: "tabular-nums" },
  ".cm-todo-box": {
    display: "inline-block",
    width: "16px",
    height: "16px",
    marginRight: "6px",
    verticalAlign: "-3px",
    border: "1.5px solid var(--line-strong, var(--muted))",
    borderRadius: "4px",
    cursor: "pointer",
    boxSizing: "border-box",
  },
  ".cm-todo-box.checked": {
    background: "var(--accent)",
    borderColor: "var(--accent)",
    position: "relative",
  },
  ".cm-todo-box.checked::after": {
    content: '""',
    position: "absolute",
    left: "4px",
    top: "1px",
    width: "4px",
    height: "8px",
    border: "solid #fff",
    borderWidth: "0 2px 2px 0",
    transform: "rotate(45deg)",
  },

  // Empty focused line placeholder + slash hint.
  ".cm-ph-line": { position: "relative" },
  ".cm-ph-line::before": {
    content: "attr(data-ph)",
    position: "absolute",
    left: "0",
    color: "var(--muted)",
    pointerEvents: "none",
  },

  // Inline marks.
  ".cm-strong": { fontWeight: "700" },
  ".cm-em": { fontStyle: "italic" },
  ".cm-del": { textDecoration: "line-through", color: "var(--muted)" },
  ".cm-code": {
    fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    fontSize: "0.9em",
    background: "var(--code-bg, var(--hover))",
    borderRadius: "4px",
    padding: "0.1em 0.35em",
  },
  ".cm-link": { color: "var(--accent)", textDecoration: "underline", cursor: "pointer" },

  // Find highlights.
  ".cm-find": { background: "var(--find-soft, rgba(255,213,0,.35))", borderRadius: "2px" },
  ".cm-find-cur": { background: "var(--accent)", color: "#fff" },
  ".cm-find-bar input": {
    border: "1px solid var(--line)",
    borderRadius: "6px",
    padding: "3px 8px",
    background: "var(--bg)",
    color: "var(--fg)",
    outline: "none",
    minWidth: "160px",
  },
  ".cm-find-count": { color: "var(--muted)", fontSize: "12px", minWidth: "38px", textAlign: "center" },

  // Hover gutter buttons.
  ".cm-g-btn": {
    display: "grid",
    placeItems: "center",
    width: "22px",
    height: "22px",
    border: "none",
    background: "transparent",
    color: "var(--muted)",
    borderRadius: "5px",
    cursor: "pointer",
  },
  ".cm-g-btn:hover": { background: "var(--hover)", color: "var(--fg)" },
  ".cm-g-grip": { cursor: "grab" },
});
