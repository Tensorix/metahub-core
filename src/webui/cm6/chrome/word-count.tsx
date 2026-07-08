/** @jsxImportSource preact */
// Floating word-count pill (bottom-right of the document view). A purely local
// read-out — nothing it shows is persisted or synced. Structurally a twin of the
// TOC plugin (toc.tsx): owns one <div> appended to view.dom, drawn with Preact,
// torn down on destroy. The whole-doc tally is debounced off docChanged; a live
// selection instead reports just the selected text. Honours the settings toggle,
// re-reading it on the same-tab WORD_COUNT_EVENT and the cross-tab `storage` event.

import { render } from "preact";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { PluginValue, ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { docModel } from "../doc-model";
import {
  countDoc,
  countText,
  getWordCountEnabled,
  WORD_COUNT_EVENT,
  type DocStats,
} from "../../wordcount";

const RECOUNT_DEBOUNCE_MS = 200;

class WordCountPlugin implements PluginValue {
  private host: HTMLElement;
  private enabled: boolean;
  private stats: DocStats = { zi: 0, chars: 0, minutes: 0 };
  private timer = 0;

  constructor(readonly view: EditorView) {
    this.host = document.createElement("div");
    this.host.className = "doc-wc";
    // Deliberately not aria-live: a count that changes on every keystroke would
    // make a screen reader announce numbers continuously. It stays a passive readout.
    view.dom.appendChild(this.host);

    this.enabled = getWordCountEnabled();
    this.host.style.display = this.enabled ? "" : "none";
    if (this.enabled) this.recount();

    window.addEventListener(WORD_COUNT_EVENT, this.onPref);
    window.addEventListener("storage", this.onStorage);
  }

  update(u: ViewUpdate) {
    if (!this.enabled) return;
    if (u.docChanged) this.schedule();
    else if (u.selectionSet) this.draw(); // selection-only change: redraw off cached doc stats
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
    window.removeEventListener(WORD_COUNT_EVENT, this.onPref);
    window.removeEventListener("storage", this.onStorage);
    render(null, this.host);
    this.host.remove();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.recount();
    }, RECOUNT_DEBOUNCE_MS);
  }

  private recount() {
    this.stats = countDoc(docModel(this.view.state));
    this.draw();
  }

  private onStorage = (e: StorageEvent) => {
    if (e.key === "mh-word-count" || e.key === null) this.onPref();
  };

  private onPref = () => {
    const on = getWordCountEnabled();
    if (on === this.enabled) return;
    this.enabled = on;
    this.host.style.display = on ? "" : "none";
    if (on) this.recount();
    else render(null, this.host);
  };

  private draw() {
    const sel = this.view.state.selection.main;
    if (!sel.empty) {
      const s = countText(this.view.state.sliceDoc(sel.from, sel.to));
      this.render(`已选 ${s.zi.toLocaleString()} 字`, `${s.chars.toLocaleString()} 字符`, null, true);
      return;
    }
    const { zi, chars, minutes } = this.stats;
    this.render(
      `${zi.toLocaleString()} 字`,
      `${chars.toLocaleString()} 字符`,
      minutes > 0 ? `约 ${minutes} 分钟阅读` : null,
      false,
    );
  }

  private render(num: string, line1: string, line2: string | null, selected: boolean) {
    this.host.classList.toggle("sel", selected);
    render(
      <>
        <span class="doc-wc-num">{num}</span>
        <div class="doc-wc-detail">
          <span>{line1}</span>
          {line2 && <span>{line2}</span>}
        </div>
      </>,
      this.host,
    );
  }
}

export function wordCount(): Extension {
  return ViewPlugin.fromClass(WordCountPlugin);
}
