/** @jsxImportSource preact */
// `[[` internal-link suggest. Typing "[[" opens a caret-anchored picker over
// every doc/db title (the same map the doclink decorations resolve against —
// no network round-trip); typing filters, Arrow keys move, Enter/click inserts
// the canonical `[[id]]` reference, Esc or breaking the "[[query" closes.
//
// Structure mirrors slash-menu.tsx: the plugin owns a `.pop` overlay on
// document.body and intercepts nav keys with a CAPTURE-phase keydown listener
// so the structure keymap never sees them while the menu is open.

import { render } from "preact";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { Icon } from "../../icons.tsx";
import { MenuLabel } from "../../ui.tsx";
import { docModel } from "../doc-model";
import { imeGhost } from "../../keys.ts";
import { deferCoords } from "../defer";
import { allDocTitles, onDocTitleChange } from "../../doc-titles.ts";

// An open trigger is the last "[[", with no closing bracket (or a nested
// opener) between it and the caret. `|` also closes the door: past the pipe
// the author is typing an explicit alias, not searching titles.
const OPEN_RE = /\[\[([^\[\]|\n]*)$/;
const MENU_WIDTH = 300;
const LIMIT = 8;

interface Match {
  id: string;
  title: string;
}

function matchesFor(query: string): Match[] {
  const q = query.trim().toLowerCase();
  const all = allDocTitles();
  if (!q) return all.slice(0, LIMIT);
  const starts: Match[] = [];
  const contains: Match[] = [];
  for (const m of all) {
    const t = m.title.toLowerCase();
    if (t.startsWith(q) || m.id.startsWith(q)) starts.push(m);
    else if (t.includes(q) || m.id.includes(q)) contains.push(m);
  }
  return [...starts, ...contains].slice(0, LIMIT);
}

interface Active {
  openFrom: number; // position of the first "[" of the trigger
  query: string;
  idx: number;
}

export function doclinkSuggest(): Extension {
  return ViewPlugin.fromClass(
    class {
      active: Active | null = null;
      menuEl: HTMLDivElement | null = null;
      raf = 0;
      readonly onKey = (e: KeyboardEvent) => this.handleKey(e);
      readonly onScroll = (e?: Event) => {
        if (e && this.menuEl && e.target instanceof Node && this.menuEl.contains(e.target)) return;
        if (this.active) this.renderMenu();
      };
      readonly unsubTitles: () => void;

      constructor(readonly view: EditorView) {
        view.dom.addEventListener("keydown", this.onKey, true);
        window.addEventListener("scroll", this.onScroll, true);
        window.addEventListener("resize", this.onScroll);
        // The title map may still be loading when the menu first opens.
        this.unsubTitles = onDocTitleChange(() => {
          if (this.active) this.renderMenu();
        });
      }

      update(u: ViewUpdate) {
        if (u.view.composing) return;
        if (u.focusChanged && !u.view.hasFocus) return this.close();
        if (!u.docChanged && !u.selectionSet) return;
        const found = this.detect();
        if (!found) return this.close();
        this.active = { openFrom: found.openFrom, query: found.query, idx: this.active?.idx ?? 0 };
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
        this.unsubTitles();
        this.close();
      }

      detect(): { openFrom: number; query: string } | null {
        const sel = this.view.state.selection.main;
        if (!sel.empty) return null;
        const line = this.view.state.doc.lineAt(sel.head);
        const info = docModel(this.view.state).lines[line.number - 1];
        if (info && info.role === "void") return null;
        const before = this.view.state.sliceDoc(line.from, sel.head);
        const m = OPEN_RE.exec(before);
        if (!m) return null;
        return { openFrom: line.from + m.index, query: m[1]! };
      }

      handleKey(e: KeyboardEvent) {
        if (!this.active) return;
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
        } else if (e.key === "Enter" || e.key === "Tab") {
          const m = matches[Math.min(this.active.idx, matches.length - 1)];
          if (m) this.select(m.id);
          e.preventDefault(); e.stopPropagation();
        }
      }

      select(id: string) {
        const state = this.view.state;
        const found = this.detect();
        this.close();
        if (!found) return;
        const head = state.selection.main.head;
        // If the author already typed (or a future auto-pair inserted) a
        // closing "]]" right after the caret, consume it.
        const after = state.sliceDoc(head, Math.min(head + 2, state.doc.length));
        const to = head + (after === "]]" ? 2 : after.startsWith("]") ? 1 : 0);
        const insert = `[[${id}]]`;
        this.view.dispatch({
          changes: { from: found.openFrom, to, insert },
          selection: { anchor: found.openFrom + insert.length },
          scrollIntoView: true,
        });
        this.view.focus();
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
        const coords = this.view.coordsAtPos(active.openFrom);
        if (!coords) { el.style.display = "none"; return; }
        const M = 8, GAP = 6;
        const topInset = parseFloat(getComputedStyle(document.body).getPropertyValue("--pop-top-inset")) || 0;
        const spaceBelow = innerHeight - coords.bottom - M;
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
            <MenuLabel>链接到</MenuLabel>
            {matches.map((m, i) => (
              <button
                key={m.id}
                class={"item" + (i === active.idx ? " sel" : "")}
                onMouseDown={(e) => { e.preventDefault(); this.select(m.id); }}
              >
                <span class="lico"><Icon name={m.id.startsWith("db_") ? "database" : "file"} cls="ico sm" /></span>
                <span class="meta"><span class="t">{m.title || "无标题"}</span><span class="d">{m.id}</span></span>
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
