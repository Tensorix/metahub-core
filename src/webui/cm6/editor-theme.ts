// Self-contained CM6 theme for the document editor. Styles the decoration classes
// emitted by block-deco.ts / inline.ts and, crucially, configures DOCUMENT-FLOW
// scrolling (`.cm-scroller { overflow: visible }`, no fixed height) so the editor
// grows with its content and the page scrolls — the invariant iOS 26 Safari needs
// for its glass bars to composite. Colors come from the app's CSS variables so the
// editor tracks the active theme.
//
// Line rhythm is calibrated to the OLD block editor (main): each block was
// `.block { padding:1px 0 }` wrapping `.editable { padding:3px 2px;
// line-height:var(--note-lh) }` — so a line's box is text + 4px vertical / 2px
// horizontal padding, and an empty paragraph line is 14×1.6 + 8 = 30.4px tall.

import { EditorView } from "@codemirror/view";
import { MAX_NEST } from "./blockmodel"; // single source of truth for nesting depth
/** Visual indent per list nesting level, in px (mirrors block-deco's level model). */
const INDENT_STEP = 24;
/** Marker-column width for list lines (see block-deco.ts GUTTER). */
const GUTTER = 26;

/** Geometry rules generated in a loop: list hanging indents, nesting offsets via
 *  the `--nest` custom property, and per-level indent guides. block-deco emits
 *  only classes (`cm-li`, `cm-nested`, `cm-nest-N`); all pixel math lives here. */
function nestRules(): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {
    // Hanging indent: the whole line sits at nest+GUTTER; text-indent pulls the
    // first row (where the marker widget renders) back to the nest column, so the
    // marker occupies [nest, nest+GUTTER) and content + wrapped rows start at
    // nest+GUTTER. `--nest` defaults to 0px at level 0 (no cm-nest-N class).
    ".cm-li": {
      paddingLeft: `calc(var(--nest, 0px) + ${GUTTER}px)`,
      textIndent: `-${GUTTER}px`,
      position: "relative",
    },
    // A nested NON-list line (heading/quote/paragraph continuation under a list
    // item): aligned to the parent item's content column; +2px is the base
    // horizontal line padding it overrides.
    ".cm-nested": { paddingLeft: "calc(var(--nest, 0px) + 2px)" },
    // An indented void widget: same grid, but `.cm-void`'s `padding: 3px 2px`
    // shorthand fixes padding-left at equal specificity — this two-class rule
    // wins on specificity, not on rule order, so the theme can't silently break.
    ".cm-void.cm-nested": { paddingLeft: "calc(var(--nest, 0px) + 2px)" },
    // Quote: 16px between the 3px rule and the text (old:
    // `.b-quote .editable { padding-left:16px }`), shifted by the nest column.
    ".cm-quote": {
      borderLeft: "3px solid var(--line-strong, var(--line))",
      paddingLeft: "calc(var(--nest, 0px) + 16px)",
      color: "var(--fg-soft)",
      fontStyle: "italic",
    },
  };
  for (let n = 1; n <= MAX_NEST; n++) {
    rules[`.cm-nest-${n}`] = { "--nest": `${n * INDENT_STEP}px` };
    // One subtle DASHED vertical guide per ancestor level (old
    // `.block-wrap.nested::before` was inset top:2px;bottom:2px — hence the 2px
    // y-offset and calc(100% - 4px) height), painted as stacked 1px background
    // gradients ~11px into each indent step, i.e. under the parent marker.
    // Guides draw on EVERY indented line — list items and nested/free indented
    // prose alike — so a paragraph staircase shows guides too, and they line up
    // at the same x as list guides.
    const imgs: string[] = [];
    const sizes: string[] = [];
    const positions: string[] = [];
    for (let j = 0; j < n; j++) {
      imgs.push("repeating-linear-gradient(to bottom, var(--line) 0 3px, transparent 3px 7px)");
      sizes.push("1px calc(100% - 4px)");
      positions.push(`${INDENT_STEP * j + 11}px 2px`);
    }
    const guide = {
      backgroundImage: imgs.join(","),
      backgroundSize: sizes.join(","),
      backgroundPosition: positions.join(","),
      backgroundRepeat: "no-repeat",
    };
    rules[`.cm-li.cm-nest-${n}`] = guide;
    rules[`.cm-nested.cm-nest-${n}`] = guide;
  }
  return rules;
}

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
    lineHeight: "var(--note-lh)",
  },
  ".cm-content": {
    padding: "0",
    caretColor: "var(--fg)",
  },
  // A selected void (accent ring) has no faithful DOM-selection representation,
  // so the browser paints a fallback caret at an unrelated spot — hide it; the
  // ring is the selection visual (class set by voidField's contentAttributes).
  ".cm-content.cm-void-selected": { caretColor: "transparent" },
  // Native drag-drop indicator (dropCursor()) — CM's default is black.
  ".cm-dropCursor": { borderLeft: "1.5px solid var(--accent)" },
  // Old block box: .block 1px + .editable 3px vertical, 2px horizontal. Empty line
  // = 14px × 1.6 + 8 = 30.4px, matching the old editor exactly.
  ".cm-line": { padding: "4px 2px" },

  // Void block widgets (code / table / media / html). Spacing MUST be padding, not
  // margin — CM6 measures a block widget's height via offsetHeight, which excludes
  // margin, so a margin would desync the height map and drift caret/selection.
  // 3px = old void-host 2px + block 1px. The 2px horizontal padding (a) aligns
  // void blocks with prose (.cm-line has 2px), and (b) keeps the selected-ring
  // box-shadow (2px outside the block) INSIDE the host box: the host has
  // contain:inline-size (styles.css) and Chromium's ink-overflow culling clips
  // paint past a size-contained box's edge at 2x DPR — a flush child's ring
  // loses its right edge.
  ".cm-void": { padding: "3px 2px" },

  // Headings — absolute px (matching main's .b-hN), so they don't scale with the
  // responsive body base. Line-height inherits var(--note-lh) (old editable had no
  // per-heading override). padding-top = old editable padding-top + block 1px.
  // Literal `# ` collapses when the caret is away (block-deco).
  ".cm-h1": { fontSize: "28px", fontWeight: "700", letterSpacing: "-.02em", paddingTop: "13px" },
  ".cm-h2": { fontSize: "22px", fontWeight: "650", letterSpacing: "-.01em", paddingTop: "9px" },
  ".cm-h3": { fontSize: "18px", fontWeight: "600", paddingTop: "5px" },
  ".cm-h4": { fontSize: "16px", fontWeight: "600", paddingTop: "3px" },
  ".cm-h5": { fontSize: "14px", fontWeight: "600" },
  ".cm-h6": { fontSize: "13px", fontWeight: "600", color: "var(--fg-soft)" },

  ".cm-divider": { position: "relative" },
  ".cm-hr": {
    display: "inline-block",
    width: "100%",
    borderBottom: "1px solid var(--line-strong, var(--line))",
    verticalAlign: "middle",
  },

  // List geometry (.cm-li / .cm-nested / .cm-nest-N / .cm-quote) is generated —
  // see nestRules(). Marker column = 26px to match main (24px centered `.marker`
  // + 2px `.editable` padding): the bullet glyph and ordered `N. ` are a 24px
  // centered box + 2px margin-right; the 16px checkbox sits in 4+16+6=26px (a bit
  // more room on the content side). So bullet/numbered/todo content left-edges all
  // land at 26px, with main's gaps (~10 / 9.5 / 6px). Fixed width (not min-width)
  // keeps the number centered like main; a wide 2–3 digit number fills/overflows
  // the box but content stays anchored.
  //
  // `text-indent:0` on every marker is CRITICAL: `.cm-li` sets `text-indent:-26px`
  // for the hanging indent, and an inline-block INHERITS that (it's a block
  // container) — which would drag the ordered number's text left, out of its box,
  // defeating text-align:center and reopening the gap. Resetting it here keeps the
  // negative indent purely at the line level (positioning the marker box) while the
  // marker's own text centers normally.
  ...nestRules(),
  ".cm-bullet": { display: "inline-block", width: "24px", marginRight: "2px", textAlign: "center", textIndent: "0", color: "var(--fg-soft)" },
  ".cm-ol-num": { display: "inline-block", width: "24px", marginRight: "2px", textAlign: "center", textIndent: "0", color: "var(--fg-soft)", fontVariantNumeric: "tabular-nums" },
  // Todo marker: an outer wrapper spanning the full 26px column (its border-box is
  // what the caret lands after — CM6 ignores margins for caret x, so a bare margin
  // would glue the caret to the checkbox on an EMPTY item). The 16px checkbox sits
  // at the left (4px in); the wrapper's empty right (~6px) is the checkbox→content
  // gap, and the caret/first-char both land at 26px.
  ".cm-todo": { display: "inline-block", width: "26px", textIndent: "0" },
  // Native checkbox, styled exactly like main's `.b-todo .marker input`
  // (15×15 + accent-color) — the OS paints the check, so checked state matches
  // the old editor. Vertical: main flex-centered a 15px box in the 22.4px text
  // row (~3.7px top offset); a -3px baseline shift lands closest for an inline
  // input.
  ".cm-todo-box": {
    width: "15px",
    height: "15px",
    margin: "0 0 0 4px",
    verticalAlign: "-3px",
    accentColor: "var(--accent)",
    cursor: "pointer",
  },
  // Checked todo line: content muted + struck (old `.b-done .editable`).
  ".cm-li-done": { color: "var(--muted)", textDecoration: "line-through" },

  // Empty-block placeholder (the single unified slash hint). The overlay
  // inherits the line's padding so the hint text aligns with the content column on
  // padded lines (headings, quotes, list items); text-indent resets .cm-li's
  // hanging indent so the hint doesn't shift into the marker column.
  ".cm-ph-line": { position: "relative" },
  ".cm-ph-line::before": {
    content: "attr(data-ph)",
    position: "absolute",
    inset: "0",
    padding: "inherit",
    boxSizing: "border-box",
    // Reset .cm-li's inherited -26px hanging indent so hints on empty list
    // items don't shift into the marker column.
    textIndent: "0",
    color: "var(--muted)",
    pointerEvents: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },

  // Inline marks.
  ".cm-strong": { fontWeight: "700" },
  ".cm-em": { fontStyle: "italic" },
  ".cm-del": { textDecoration: "line-through", color: "var(--muted)" },
  ".cm-code": {
    fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    fontSize: "0.9em",
    background: "var(--surface-2)",
    borderRadius: "4px",
    padding: "1px 5px",
  },
  ".cm-link": { color: "var(--accent)", textDecoration: "underline", cursor: "pointer" },
  // Internal `[[doc_x]]` reference pill (collapsed) and its revealed source.
  ".cm-doclink": {
    background: "var(--surface-2)",
    border: "1px solid var(--line)",
    borderRadius: "6px",
    padding: "0 5px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  ".cm-doclink::before": { content: '"📄"', fontSize: "0.85em", marginRight: "3px" },
  ".cm-doclink:hover": { background: "var(--hover)" },
  ".cm-doclink-missing": {
    color: "var(--muted)",
    borderStyle: "dashed",
    textDecoration: "line-through",
    cursor: "default",
  },
  ".cm-doclink-src": { color: "var(--accent)", cursor: "pointer" },
  // Revealed markdown delimiters (`**`, `` ` ``, `# `, `> `, link brackets…): keep
  // them visually quiet while the caret edits inside the span/line.
  ".cm-md-mark": { color: "var(--muted)" },

  // Find highlights — same accent tones the old ::highlight(mh-find-*) rules used.
  // The find BAR itself mounts on document.body — outside the editor root, so
  // EditorView.theme rules can never reach it. Its styles live in styles.css
  // (.find-bar family, shared design with main). Don't add bar rules here.
  ".cm-find": { background: "color-mix(in srgb, var(--accent) 26%, transparent)", borderRadius: "2px" },
  ".cm-find-cur": { background: "var(--accent)", color: "var(--accent-fg)" },

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
