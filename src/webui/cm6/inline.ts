// Inline live-preview for the single-document editor.
//
// Renders `**bold**`/`__bold__`, `*italic*` / `_italic_`, `` `code` ``,
// `~~strike~~`, `[text](url)` and inline `![alt](url)` images by styling the
// inner content and COLLAPSING the delimiters — until the caret enters the
// span, when the raw markers reappear so you edit real text (the inline
// analogue of reveal-to-edit). Inline decorations may come from a ViewPlugin
// (only block:true replace may not), so this layer is viewport-scoped for
// performance and guarded against IME composition.
//
// The grammar itself lives in webui/inline-tokens.ts (shared with the table
// HTML bridge and the TOC) — this file only maps tokens to decorations. It is
// single-level (no nested emphasis) and escape-aware (`\*x\*` stays literal).
// Void source lines (fenced code/html, block media, tables) are skipped so
// their literal `**`/backticks stay literal.
//
// Links: the styled span carries data-href; clicking a collapsed link (or
// Mod-clicking a revealed one) opens the URL, a plain click on a revealed link
// just places the caret.

import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { StateEffect, type Extension, type Range, type EditorSelection } from "@codemirror/state";
import { docModel } from "./doc-model";
import { tokenizeInline, type InlineToken } from "../inline-tokens";
import { safeUrl } from "../../core/md/grammar.ts";
import { docLinkTitle, onDocTitleChange } from "../doc-titles.ts";
import { toast } from "../ui.tsx";

const CLASS: Record<Exclude<InlineToken["kind"], "image" | "doclink">, string> = {
  code: "cm-code",
  strong: "cm-strong",
  em: "cm-em",
  del: "cm-del",
  link: "cm-link",
};

/** Collapsed inline `![alt](url)` — the whole token is replaced by the image. */
class InlineImgWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
  ) {
    super();
  }

  override eq(other: InlineImgWidget): boolean {
    return other.url === this.url && other.alt === this.alt;
  }

  override toDOM(view: EditorView): HTMLElement {
    const img = document.createElement("img");
    img.className = "doc-img cm-inline-img";
    img.src = this.url;
    img.alt = this.alt;
    img.loading = "lazy";
    // styles.css scopes img.doc-img to .editable; keep the essentials inline.
    img.style.maxWidth = "100%";
    img.style.height = "auto";
    img.style.borderRadius = "6px";
    img.style.verticalAlign = "bottom";
    img.onload = () => view.requestMeasure();
    return img;
  }

  // Let the editor handle clicks: the selection lands on the token, which
  // reveals the `![alt](url)` source for editing.
  override ignoreEvent(): boolean {
    return false;
  }
}

/** Collapsed `[[doc_x]]` — an internal-reference pill showing the live title. */
class DocLinkWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly label: string,
    readonly missing: boolean,
  ) {
    super();
  }

  override eq(other: DocLinkWidget): boolean {
    return other.id === this.id && other.label === this.label && other.missing === this.missing;
  }

  override toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.missing ? "cm-doclink cm-doclink-missing" : "cm-doclink";
    el.setAttribute("data-doclink", this.id);
    if (this.missing) el.setAttribute("data-doclink-missing", "1");
    el.textContent = this.label;
    return el;
  }

  // Clicks are handled by linkClicks (navigate / toast); CM must not also turn
  // them into a selection change that would reveal the source mid-click.
  override ignoreEvent(): boolean {
    return true;
  }
}

/** Display label for a `[[id|alias]]` token: explicit alias > live title > id.
 *  While the title map is still loading the id doubles as a readable fallback
 *  (it embeds the title's slug); a known-missing target keeps the id and gets
 *  the broken-link style. */
function docLinkLabel(id: string, alias: string | undefined): { label: string; missing: boolean } {
  if (alias) return { label: alias, missing: docLinkTitle(id) === null };
  const title = docLinkTitle(id);
  if (title === null) return { label: id, missing: true };
  if (title === undefined) return { label: id, missing: false };
  return { label: title || "无标题", missing: false };
}

/** Rebuild signal for open editors when a referenced title changes. */
const docTitlesChanged = StateEffect.define<null>();

/** Does the selection touch [from, to] (endpoints inclusive)? → reveal delimiters. */
function touches(sel: EditorSelection, from: number, to: number): boolean {
  return sel.ranges.some((r) => r.from <= to && r.to >= from);
}

/** Per-line token cache. Tokens are a pure function of the line TEXT, but the
 *  plugin rebuilds on every selectionSet (the reveal state changes) — without
 *  this, holding an arrow key re-tokenized every visible line ~30×/s for
 *  output identical except one span's reveal flag. Keyed by line number,
 *  validated by text; rebuilt maps drop lines that left the viewport. */
type TokenCache = Map<number, { text: string; tokens: InlineToken[] }>;

function build(view: EditorView, cache: TokenCache, next: TokenCache): DecorationSet {
  const model = docModel(view.state);
  const sel = view.state.selection;
  const out: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      pos = line.to + 1;
      const info = model.lines[line.number - 1];
      if (info && info.role === "void") continue; // literal source — don't tokenize
      const text = line.text;
      if (!text) continue;

      const hit = cache.get(line.number);
      const tokens = hit && hit.text === text ? hit.tokens : tokenizeInline(text);
      next.set(line.number, { text, tokens });

      for (const t of tokens) {
        const absStart = line.from + t.start;
        const absEnd = line.from + t.end;
        const absInnerFrom = line.from + t.innerFrom;
        const absInnerTo = line.from + t.innerTo;
        const revealed = touches(sel, absStart, absEnd);

        if (t.kind === "image") {
          if (!revealed) {
            out.push(
              Decoration.replace({ widget: new InlineImgWidget(t.url!, t.alt ?? "") }).range(absStart, absEnd),
            );
          } else {
            // Revealed: full `![alt](url)` source with muted delimiters.
            out.push(Decoration.mark({ class: "cm-md-mark" }).range(absStart, absInnerFrom));
            if (absEnd > absInnerTo) out.push(Decoration.mark({ class: "cm-md-mark" }).range(absInnerTo, absEnd));
          }
          continue;
        }

        if (t.kind === "doclink") {
          if (!revealed) {
            const { label, missing } = docLinkLabel(t.id!, t.alias);
            out.push(
              Decoration.replace({ widget: new DocLinkWidget(t.id!, label, missing) }).range(absStart, absEnd),
            );
          } else {
            // Revealed: `[[id|alias]]` source; delimiters muted, target styled.
            out.push(
              Decoration.mark({
                class: "cm-doclink-src",
                attributes: { "data-doclink": t.id!, "data-md-revealed": "1" },
              }).range(absInnerFrom, absInnerTo),
            );
            if (absInnerFrom > absStart) out.push(Decoration.mark({ class: "cm-md-mark" }).range(absStart, absInnerFrom));
            if (absEnd > absInnerTo) out.push(Decoration.mark({ class: "cm-md-mark" }).range(absInnerTo, absEnd));
          }
          continue;
        }

        const mark =
          t.kind === "link"
            ? Decoration.mark({
                class: CLASS.link,
                attributes: revealed
                  ? { "data-href": t.url!, "data-md-revealed": "1" }
                  : { "data-href": t.url! },
              })
            : Decoration.mark({ class: CLASS[t.kind] });
        out.push(mark.range(absInnerFrom, absInnerTo));
        if (!revealed) {
          if (absInnerFrom > absStart) out.push(Decoration.replace({}).range(absStart, absInnerFrom));
          if (absEnd > absInnerTo) out.push(Decoration.replace({}).range(absInnerTo, absEnd));
        } else {
          // Revealed: the delimiters (`**`, `` ` ``, `~~`, `[`/`](url)`…) show as
          // real text but muted, so the span stays readable while you edit it.
          if (absInnerFrom > absStart) out.push(Decoration.mark({ class: "cm-md-mark" }).range(absStart, absInnerFrom));
          if (absEnd > absInnerTo) out.push(Decoration.mark({ class: "cm-md-mark" }).range(absInnerTo, absEnd));
        }
      }
    }
  }
  return Decoration.set(out, true);
}

const inlinePlugin = ViewPlugin.fromClass(
  class {
    deco: DecorationSet;
    cache: TokenCache = new Map();
    stale = false;
    dead = false;
    unsubTitles: () => void;
    constructor(view: EditorView) {
      this.deco = this.run(view);
      // A doclink's label is resolved at build time; when a referenced title
      // changes (rename synced in, nav reload) the tokens are identical, so
      // nudge a rebuild through a dedicated effect.
      this.unsubTitles = onDocTitleChange(() => {
        queueMicrotask(() => {
          if (!this.dead) view.dispatch({ effects: docTitlesChanged.of(null) });
        });
      });
    }
    destroy() {
      this.dead = true;
      this.unsubTitles();
    }
    update(u: ViewUpdate) {
      if (u.view.composing) {
        // Mid-IME: don't rebuild (a redraw would abort the composition), but
        // keep positions honest — the preedit string grows the doc, and an
        // unmapped set smears replace/mark decos onto the wrong characters
        // downstream of the caret (next line "loses" letters, delimiters leak).
        if (u.docChanged) {
          this.deco = this.deco.map(u.changes);
          this.stale = true;
        }
        return;
      }
      const titlesChanged = u.transactions.some((tr) => tr.effects.some((e) => e.is(docTitlesChanged)));
      if (this.stale || u.docChanged || u.selectionSet || u.viewportChanged || titlesChanged) {
        this.stale = false;
        this.deco = this.run(u.view);
      }
    }
    private run(view: EditorView): DecorationSet {
      const next: TokenCache = new Map();
      const deco = build(view, this.cache, next);
      this.cache = next;
      return deco;
    }
  },
  { decorations: (v) => v.deco },
);

/** Open a collapsed link on click; a revealed link needs Mod (Cmd/Ctrl) so a
 *  plain click can place the caret in the source text. */
const linkClicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0) return false;
    // Internal `[[doc_x]]` reference: navigate in-app via the hash router
    // (hashchange is the app's single back/forward listener). A revealed one
    // needs Mod, like external links, so a plain click can place the caret.
    const dl = (e.target as HTMLElement | null)?.closest?.("[data-doclink]");
    if (dl instanceof HTMLElement && view.dom.contains(dl)) {
      const mod = e.metaKey || e.ctrlKey;
      if (dl.hasAttribute("data-md-revealed") && !mod) return false; // caret placement
      e.preventDefault();
      const id = dl.getAttribute("data-doclink")!;
      if (dl.hasAttribute("data-doclink-missing") || docLinkTitle(id) === null) {
        toast("文档不存在或未同步");
        return true;
      }
      location.hash = `#/${id.startsWith("db_") ? "db" : "doc"}/${encodeURIComponent(id)}`;
      return true;
    }
    const el = (e.target as HTMLElement | null)?.closest?.("[data-href]");
    if (!(el instanceof HTMLElement) || !view.dom.contains(el)) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (el.hasAttribute("data-md-revealed") && !mod) return false; // caret placement
    const raw = el.getAttribute("data-href");
    if (!raw) return false;
    e.preventDefault();
    // Whitelist the scheme — a `javascript:`/`data:text/html` link from a synced
    // doc must not open/execute; safeUrl returns "#" for anything rejected.
    const href = safeUrl(raw);
    if (href !== "#") window.open(href, "_blank", "noopener");
    return true;
  },
});

export const inlineDecorations: Extension = [inlinePlugin, linkClicks];
