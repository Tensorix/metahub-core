/** @jsxImportSource preact */
// Slash command menu. Typing "/" at the start of an otherwise-empty line — or at
// the content start of an otherwise-empty list/quote/todo item — opens a
// caret-anchored block-type picker; typing filters, Arrow keys move, Enter/click
// selects, Esc or deleting the "/" closes. Selecting a type rewrites the "/query"
// line as the chosen block's canonical Markdown (on a marker line the marker is
// replaced, indent kept), so the scanner re-derives the block on the next change
// (no conversion handoff). Upload/embed types hand off to the host via `onUpload`.
//
// The menu owns its overlay (a `.pop` appended to document.body) and intercepts the
// nav keys with a CAPTURE-phase keydown listener on view.dom, which preempts the
// Prec.highest structure keymap while the menu is open.

import { render } from "preact";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import type { Extension, EditorState, Line } from "@codemirror/state";
import { Icon } from "../../icons.tsx";
import { MenuLabel } from "../../ui.tsx";
import { BLOCK_MENU, type BlockType } from "../../blocks.ts";
import { docModel } from "../doc-model";
import type { LineInfo, LineRole } from "../blockmodel";
import { focusNewCodeVoid } from "../structure";
import { imeGhost } from "../../keys.ts";
import { deferCoords } from "../defer";

export interface SlashDeps {
  /** Called for an upload/embed type (image/video/audio/file). The "/query" text
   *  is already removed and the caret sits on a clean empty line at `pos`. */
  onUpload?(type: BlockType, view: EditorView, pos: number): void;
}

const SLASH_RE = /^(\s*)\/(\S*)$/;
/** Same shape, but matched against a marker line's CONTENT (after `- ` / `> ` /
 *  `- [ ] ` / `1. `): the slash must be the first content character. */
const CONTENT_SLASH_RE = /^\/(\S*)$/;
/** Marker-bearing roles where "/" triggers on the content, not the whole line. */
const MARKER_ROLES: ReadonlySet<LineRole> = new Set(["bullet", "numbered", "todo", "quote"]);
/** Types whose insertion spans several lines and must be indented to nest under a
 *  list item instead of breaking the list. */
const MULTILINE_TYPES: ReadonlySet<BlockType> = new Set(["code", "html", "table"]);
const MENU_WIDTH = 264;

/** Find an open "/query" on `line`, or null. On a list/quote line the trigger is
 *  the content after the marker (anchor = `contentFrom`); on p/blank lines the
 *  whole line must be whitespace + "/query" (anchor = after the indent). Void
 *  lines never trigger. */
function slashAt(
  state: EditorState,
  line: Line,
): { slashFrom: number; query: string; info: LineInfo | undefined } | null {
  const info = docModel(state).lines[line.number - 1];
  if (info && info.role === "void") return null;
  if (info && MARKER_ROLES.has(info.role)) {
    const m = CONTENT_SLASH_RE.exec(state.sliceDoc(info.contentFrom, line.to));
    if (!m) return null;
    return { slashFrom: info.contentFrom, query: m[1]!, info };
  }
  const m = SLASH_RE.exec(line.text);
  if (!m) return null;
  return { slashFrom: line.from + m[1]!.length, query: m[2]!, info };
}

function matchesFor(query: string) {
  const q = query.toLowerCase();
  if (!q) return BLOCK_MENU;
  return BLOCK_MENU.filter((m) => (m.t + m.type + m.d).toLowerCase().includes(q));
}

/** The Markdown to write for a chosen block type and the caret offset relative to
 *  the line start `from`. `insert === null` → an upload/embed type. */
function blockInsertion(type: BlockType, from: number): { insert: string | null; caret: number } {
  const marker = (m: string) => ({ insert: m, caret: from + m.length });
  switch (type) {
    case "p": return { insert: "", caret: from };
    case "h1": return marker("# ");
    case "h2": return marker("## ");
    case "h3": return marker("### ");
    case "bullet": return marker("- ");
    case "numbered": return marker("1. ");
    case "todo": return marker("- [ ] ");
    case "quote": return marker("> ");
    case "divider": return { insert: "---\n", caret: from + 4 };
    case "code": return { insert: "```\n\n```", caret: from + 4 };
    case "table": return { insert: "| 列1 | 列2 |\n| --- | --- |\n|  |  |", caret: from };
    case "html": return { insert: "```mh-html\n\n```", caret: from + 11 };
    default: return { insert: null, caret: from }; // image / video / audio / file
  }
}

interface Active {
  slashFrom: number;
  query: string;
  idx: number;
}

export function slashMenu(deps: SlashDeps = {}): Extension {
  return ViewPlugin.fromClass(
    class {
      active: Active | null = null;
      menuEl: HTMLDivElement | null = null;
      raf = 0;
      readonly onKey = (e: KeyboardEvent) => this.handleKey(e);
      // Reposition on PAGE scroll only. Ignore scrolls originating inside the menu
      // itself (its .pop is overflow:auto) — otherwise every wheel tick re-runs
      // renderMenu and fights the internal scroll, so it never reaches the bottom.
      readonly onScroll = (e?: Event) => {
        if (e && this.menuEl && e.target instanceof Node && this.menuEl.contains(e.target)) return;
        if (this.active) this.renderMenu();
      };

      constructor(readonly view: EditorView) {
        view.dom.addEventListener("keydown", this.onKey, true);
        window.addEventListener("scroll", this.onScroll, true);
        window.addEventListener("resize", this.onScroll);
      }

      update(u: ViewUpdate) {
        if (u.view.composing) return;
        if (u.focusChanged && !u.view.hasFocus) return this.close();
        if (!u.docChanged && !u.selectionSet) return;
        const found = this.detect();
        if (!found) return this.close();
        this.active = { slashFrom: found.slashFrom, query: found.query, idx: this.active?.idx ?? 0 };
        if (this.raf) return;
        this.raf = deferCoords(() => {
          this.raf = 0;
          if (this.active) this.renderMenu();
        });
      }

      destroy() {
        if (this.raf) cancelAnimationFrame(this.raf);
        this.view.dom.removeEventListener("keydown", this.onKey, true);
        window.removeEventListener("scroll", this.onScroll, true);
        window.removeEventListener("resize", this.onScroll);
        this.close();
      }

      detect(): { slashFrom: number; query: string } | null {
        const sel = this.view.state.selection.main;
        if (!sel.empty) return null;
        const line = this.view.state.doc.lineAt(sel.head);
        const found = slashAt(this.view.state, line);
        if (!found || sel.head <= found.slashFrom) return null;
        return found;
      }

      handleKey(e: KeyboardEvent) {
        if (!this.active) return;
        // IME composition keys (candidate confirm/navigation) are NOT menu
        // input: without this guard, a pinyin user pressing Enter to commit a
        // candidate inserts a block instead of their text (the old editor had
        // the same guard at the top of its onKeyDown).
        if (imeGhost(e)) return;
        if (e.key === "Escape") { this.close(); e.preventDefault(); e.stopPropagation(); return; }
        const matches = matchesFor(this.active.query);
        if (!matches.length) return;
        if (e.key === "ArrowDown") {
          this.active.idx = Math.min(this.active.idx + 1, matches.length - 1);
          this.renderMenu(); e.preventDefault(); e.stopPropagation();
        } else if (e.key === "ArrowUp") {
          this.active.idx = Math.max(this.active.idx - 1, 0);
          this.renderMenu(); e.preventDefault(); e.stopPropagation();
        } else if (e.key === "Enter") {
          const m = matches[Math.min(this.active.idx, matches.length - 1)];
          if (m) this.select(m.type);
          e.preventDefault(); e.stopPropagation();
        }
      }

      select(type: BlockType) {
        const state = this.view.state;
        const line = state.doc.lineAt(state.selection.main.head);
        const found = slashAt(state, line);
        this.close();
        if (!found) return;
        const info = found.info;
        // On a marker line the chosen type REPLACES the marker (old editor's
        // convert semantics): rewrite from `markerFrom`, keeping the indent.
        const onMarker = info !== undefined && MARKER_ROLES.has(info.role);
        const from = onMarker ? info.markerFrom : line.from;
        let { insert, caret } = blockInsertion(type, from);
        if (insert === null) {
          this.view.dispatch({ changes: { from, to: line.to, insert: "" }, selection: { anchor: from } });
          this.view.focus();
          deps.onUpload?.(type, this.view, from);
          return;
        }
        let changeFrom = from;
        if (onMarker && MULTILINE_TYPES.has(type)) {
          // A fence/table can't live on a list marker line: replace the whole
          // line and indent every inserted line two columns past the item's
          // indent, so the block parses as the list item's child.
          const prefix = state.sliceDoc(line.from, info.markerFrom) + "  ";
          const rel = caret - from; // caret offset inside `insert`
          const newlinesBeforeCaret = (insert.slice(0, rel).match(/\n/g) ?? []).length;
          insert = insert.split("\n").map((l) => prefix + l).join("\n");
          changeFrom = line.from;
          caret = line.from + rel + prefix.length * (newlinesBeforeCaret + 1);
        }
        this.view.dispatch({ changes: { from: changeFrom, to: line.to, insert }, selection: { anchor: caret }, scrollIntoView: true });
        this.view.focus();
        // The inserted fence is an atomic void: the dispatched caret sits inside
        // the replaced range where nothing renders. Hand focus to the island's
        // textarea as soon as its widget mounts (same handoff as enterCommand's
        // fence paths). html is reveal-to-edit (non-atomic) — no handoff needed.
        if (type === "code") focusNewCodeVoid(this.view, caret);
      }

      renderMenu() {
        const active = this.active;
        if (!active) return;
        const matches = matchesFor(active.query);
        if (!matches.length) { if (this.menuEl) this.menuEl.style.display = "none"; return; }
        if (active.idx > matches.length - 1) active.idx = matches.length - 1;
        if (!this.menuEl) {
          const el = document.createElement("div");
          el.className = "pop cm-slash-menu";
          el.style.zIndex = "90";
          el.addEventListener("mousedown", (e) => e.preventDefault());
          document.body.appendChild(el);
          this.menuEl = el;
        }
        const el = this.menuEl;
        const coords = this.view.coordsAtPos(active.slashFrom);
        if (!coords) { el.style.display = "none"; return; }
        const M = 8, GAP = 6;
        // --pop-top-inset: extra top clearance a surface can demand (the desktop
        // quick-note window sets it to its drag bar's height so an upward menu
        // can't cover the bar / macOS traffic lights).
        const topInset = parseFloat(getComputedStyle(document.body).getPropertyValue("--pop-top-inset")) || 0;
        const spaceBelow = innerHeight - coords.bottom - M;
        // GAP is part of the upward budget: the menu bottom sits at coords.top -
        // GAP, so without it the top edge would land GAP px above the inset line.
        const spaceAbove = coords.top - GAP - Math.max(M, topInset);
        const below = spaceBelow >= 240 || spaceBelow >= spaceAbove;
        const left = Math.max(M, Math.min(coords.left, innerWidth - MENU_WIDTH - M));
        const maxHeight = Math.round(Math.min(below ? spaceBelow : spaceAbove, innerHeight * 0.7));
        el.style.display = "";
        el.style.left = `${left}px`;
        el.style.minWidth = `${MENU_WIDTH}px`;
        el.style.maxHeight = `${maxHeight}px`;
        el.style.top = below ? `${coords.bottom + GAP}px` : "";
        el.style.bottom = below ? "" : `${innerHeight - coords.top + GAP}px`;
        render(
          <>
            <MenuLabel>基础块</MenuLabel>
            {matches.map((m, i) => (
              <button
                key={m.type}
                class={"item" + (i === active.idx ? " sel" : "")}
                onMouseDown={(e) => { e.preventDefault(); this.select(m.type); }}
              >
                <span class="lico"><Icon name={m.ic} cls="ico sm" /></span>
                <span class="meta"><span class="t">{m.t}</span><span class="d">{m.d}</span></span>
              </button>
            ))}
          </>,
          el,
        );
        el.querySelector(".item.sel")?.scrollIntoView({ block: "nearest" });
      }

      close() {
        this.active = null;
        if (this.menuEl) { render(null, this.menuEl); this.menuEl.remove(); this.menuEl = null; }
      }
    },
  );
}
