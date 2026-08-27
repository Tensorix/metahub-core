// Auto-title derivation for quick notes: the note's title mirrors its first
// usable body line (Apple-Notes style) until the user edits the title by hand.
//
// Everything here is a PURE function of (body, created_hlc). That purity is
// load-bearing: "is this title auto-derived?" is inferred statelessly on load
// by re-deriving and comparing (see isAutoTitleState), so the same inputs must
// produce the same title across sessions, windows, and days. No async lookups
// (doc-title resolution for [[doc_id]] links), no Date.now() in the derive
// path — the fallback date comes from created_hlc, never "today", so a note
// reopened tomorrow still matches its own date title.
import { RE, matchListLine, matchMediaEmbed, matchQuoteLine } from "../../core/md/grammar.ts";
import { stripInlineTokens, tokenizeInline } from "../inline-tokens.ts";

export const AUTO_TITLE_MAX = 64;

// How many non-blank lines to consider before giving up. Lets a note that
// opens with a pasted screenshot or a divider still get a text title.
const SCAN_LIMIT = 5;

/** Plain-text title derived from the first usable body line, or null when no
 *  line yields text (all-media note, opens with a code fence, ...). */
export function deriveAutoTitle(body: string): string | null {
  let scanned = 0;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "") continue;
    if (++scanned > SCAN_LIMIT) break;
    // A fence or table means the note BODY starts with code/data — a code line
    // makes a worse title than the date fallback, so stop scanning entirely
    // rather than pull a line from inside the construct.
    if (RE.fenceOpen.test(t) || t.startsWith("|")) return null;
    if (RE.divider.test(t)) continue;
    if (matchMediaEmbed(t)) continue;
    // Peel block markers (heading / quote / list), bounded so `> - **x**`
    // nesting resolves but a pathological line can't loop.
    let text = t;
    for (let i = 0; i < 3; i++) {
      const h = text.match(RE.h);
      if (h) { text = h[2]!; continue; }
      const q = matchQuoteLine(text);
      if (q !== null) { text = q.trim(); continue; }
      const l = matchListLine(text, 0);
      if (l) { text = l.content.trim(); continue; }
      break;
    }
    // A bare [[doc_id]] is a reference, not prose — the id string has zero
    // recognition value as a title, so drop it. `[[id|alias]]` keeps its alias
    // (stripInlineTokens flattens it to the alias below).
    const toks = tokenizeInline(text);
    if (toks.some((tok) => tok.kind === "doclink" && tok.alias === undefined)) {
      let out = "";
      let pos = 0;
      for (const tok of toks) {
        out += text.slice(pos, tok.start);
        if (!(tok.kind === "doclink" && tok.alias === undefined)) out += text.slice(tok.start, tok.end);
        pos = tok.end;
      }
      text = out + text.slice(pos);
    }
    text = stripInlineTokens(text).replace(/\s+/g, " ").trim();
    if (text === "") continue;
    // Truncate by code point (not UTF-16 unit) so an emoji surrogate pair is
    // never split. No ellipsis: the title must be exactly reproducible from
    // the body for the stateless auto-mode inference, and a pure prefix is.
    return Array.from(text).slice(0, AUTO_TITLE_MAX).join("");
  }
  return null;
}

/** created_hlc → "2026年8月28日" (local calendar day, no zero padding — the
 *  date.ts convention is local time). HLC wall clock is the decimal millis
 *  before the first "-"; an unparseable value falls back to `now`. */
export function dateTitleFromHlc(hlc: string | null | undefined, now: Date = new Date()): string {
  let d = now;
  if (hlc) {
    const dash = hlc.indexOf("-");
    const ms = Number(dash > 0 ? hlc.slice(0, dash) : hlc);
    if (Number.isFinite(ms) && ms > 0) d = new Date(ms);
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** The title an auto-mode note should carry right now. Empty body → "" (so a
 *  cleared note returns to 无标题 instead of freezing a stale derived title,
 *  which would also trip the inference below into manual mode). */
export function autoTitleFor(body: string, createdHlc: string | null): string {
  if (body.trim() === "") return "";
  return deriveAutoTitle(body) ?? dateTitleFromHlc(createdHlc);
}

/** Stateless auto-mode inference at load time: a title is auto-managed iff it
 *  is empty, the current derivation, or the date fallback. A hand-edited title
 *  matches none of the three arms, so manual mode survives window restarts
 *  without any persisted flag. */
export function isAutoTitleState(title: string, body: string, createdHlc: string | null): boolean {
  return (
    title === "" ||
    title === autoTitleFor(body, createdHlc) ||
    title === dateTitleFromHlc(createdHlc)
  );
}
