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
    // No font-size here: inherit from .cm-doc-body ← .doc ← body, which is the
    // responsive base (14px desktop; 16px on mobile via the styles.css media query).
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

  // Headings — absolute px (matching main's .b-hN), so they don't scale with the
  // responsive body base. Literal `# ` collapses when the caret is away (block-deco).
  ".cm-h1": { fontSize: "28px", fontWeight: "700", lineHeight: "1.3", margin: "0" },
  ".cm-h2": { fontSize: "22px", fontWeight: "700", lineHeight: "1.3" },
  ".cm-h3": { fontSize: "18px", fontWeight: "600" },
  ".cm-h4": { fontSize: "16px", fontWeight: "600" },
  ".cm-h5": { fontSize: "14px", fontWeight: "600" },
  ".cm-h6": { fontSize: "13px", fontWeight: "600", color: "var(--muted)" },

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

  // List lines — leading whitespace hidden, indent supplied by padding-left. All
  // three markers occupy a 24px CENTERED column (matching main's `.marker`): the
  // bullet glyph, the ordered `N. `, and the 16px checkbox (centered via 4px side
  // margins) — so bullet/numbered/todo content left-edges align with a uniform,
  // tight gap. Fixed width (not min-width) keeps the ordered number centered like
  // main; a wide 2–3 digit number fills/overflows the box but content stays anchored.
  //
  // `text-indent:0` on every marker is CRITICAL: `.cm-li` sets `text-indent:-24px`
  // for the hanging indent, and an inline-block INHERITS that (it's a block
  // container) — which would drag the ordered number's text 24px to the left, out of
  // its box, defeating text-align:center and reopening the gap. Resetting it here
  // keeps the -24px purely at the line level (positioning the marker box) while the
  // marker's own text centers normally.
  ".cm-li": { position: "relative" },
  ".cm-bullet": { display: "inline-block", width: "24px", textAlign: "center", textIndent: "0", color: "var(--muted)" },
  ".cm-ol-num": { display: "inline-block", width: "24px", textAlign: "center", textIndent: "0", color: "var(--muted)", fontVariantNumeric: "tabular-nums" },
  ".cm-todo-box": {
    display: "inline-block",
    width: "16px",
    height: "16px",
    margin: "0 4px",
    textIndent: "0",
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
