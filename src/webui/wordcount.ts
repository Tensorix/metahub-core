// Pure, client-side word counting for the document view (never persisted, never
// synced). Counts the *rendered prose*, not the raw Markdown source: it walks the
// derived DocModel (blockmodel.ts) so markers (`#`, `- `, `> `), media embeds, and
// table pipes don't inflate the number, and strips inline tokens so a link counts
// its label text, an image its alt.
//
// Counting rule (Word / WPS / Typora convention for mixed CJK + Latin text): every
// CJK character counts as one "字", every run of Latin letters/digits counts as one
// word, and the two are summed. Reading time splits them back apart (CJK reads
// faster per glyph than Latin per word).

import type { DocModel } from "./cm6/blockmodel";
import { scanDoc } from "./cm6/blockmodel";
import { stripInlineTokens } from "./inline-tokens";

export interface DocStats {
  /** Total "字数": CJK glyphs (each 1) + Latin/number words (each 1). */
  zi: number;
  /** Non-whitespace character count (code points). */
  chars: number;
  /** Estimated reading time in whole minutes (0 for an empty doc, else ≥1). */
  minutes: number;
}

/** localStorage preference. Default ON — absence means enabled; the string "0"
 *  is the only value that turns it off (mirrors theme.ts's get/set shape). */
const KEY = "mh-word-count";

/** Fired on the window when the toggle changes in THIS tab, so an already-mounted
 *  editor's word-count plugin re-reads the preference immediately (the native
 *  `storage` event only crosses tabs, never same-tab). */
export const WORD_COUNT_EVENT = "mh-word-count-change";

export function getWordCountEnabled(): boolean {
  return localStorage.getItem(KEY) !== "0";
}

export function setWordCountEnabled(enabled: boolean): void {
  if (enabled) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, "0");
  window.dispatchEvent(new CustomEvent(WORD_COUNT_EVENT));
}

// Han, Hiragana, Katakana, Hangul — the scripts counted per-glyph. Everything
// else falls through to word-run matching.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
// A Latin/number "word": letter/digit runs, allowing internal apostrophes and
// hyphens (don't split "can't" or "state-of-the-art"). CJK is stripped first so
// \p{L} here only ever sees non-CJK letters.
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

interface Acc {
  cjk: number;
  words: number;
  chars: number;
}

/** Fold one plain-text fragment (already marker-free, inline-tokens stripped for
 *  prose) into the running tally. */
function tally(text: string, acc: Acc): void {
  const cjk = text.match(CJK);
  acc.cjk += cjk ? cjk.length : 0;
  const words = text.replace(CJK, " ").match(WORD);
  acc.words += words ? words.length : 0;
  for (const ch of text) if (!/\s/u.test(ch)) acc.chars++;
}

function finalize(acc: Acc): DocStats {
  const zi = acc.cjk + acc.words;
  // ~400 CJK glyphs/min, ~200 Latin words/min — standard reading-speed splits.
  const minutes = zi === 0 ? 0 : Math.max(1, Math.ceil(acc.cjk / 400 + acc.words / 200));
  return { zi, chars: acc.chars, minutes };
}

/** Count a whole document via its derived model. Prose lines contribute their
 *  post-marker, inline-stripped text; code voids contribute their literal source;
 *  tables contribute their cell text; media / html / raw-HTML voids contribute
 *  nothing (URLs and markup aren't prose). */
export function countDoc(model: DocModel): DocStats {
  const acc: Acc = { cjk: 0, words: 0, chars: 0 };

  for (const line of model.lines) {
    // Void lines are handled per-void below; blanks and dividers hold no text.
    if (line.role === "void" || line.role === "blank" || line.role === "divider") continue;
    const content = line.text.slice(line.contentFrom - line.from);
    if (content) tally(stripInlineTokens(content), acc);
  }

  for (const v of model.voids) {
    if (v.kind === "code") {
      // Literal code — count as-is, no inline stripping (fences excluded already:
      // block.content is the interior only).
      tally(v.block.content, acc);
    } else if (v.kind === "table") {
      for (const row of v.block.rows ?? [])
        for (const cell of row) tally(stripInlineTokens(cell), acc);
    }
    // image | video | audio | file | html → skipped.
  }

  return finalize(acc);
}

/** Count an arbitrary plain-text fragment (the current selection). Inline tokens
 *  are stripped so a selected `[label](url)` counts "label". */
export function countText(text: string): DocStats {
  const acc: Acc = { cjk: 0, words: 0, chars: 0 };
  tally(stripInlineTokens(text), acc);
  return finalize(acc);
}

/** Convenience for tests / callers holding a raw Markdown string. */
export function countSource(src: string): DocStats {
  return countDoc(scanDoc(src));
}
