// Read-boundary healing of LEGACY marker forms the pre-strict serializer
// emitted. The strict grammar (./grammar.ts) requires trailing whitespace after
// every marker; two historical forms predate the tightening:
//
//   • empty todo without the trailing space: old lenient parsing accepted
//     `- [ ]` as a todo; strict reads it as a bullet whose content is `[ ]`.
//   • bare `>` for an empty line INSIDE a quote block: the old serializer wrote
//     `>${line ? " " + line : ""}`, so a multi-paragraph quote was stored as
//     `> a` / `>` / `> b`. Strict reads the bare `>` as a paragraph, splitting
//     the quote in two with a literal ">" line between.
//
// healLegacyMarkdown restores the serializer's canonical forms (append the
// missing space). Deliberately narrow — the grammar itself is NOT relaxed:
//   • todo: only lines ENDING at the `]` (an empty todo); `- [ ]x` stays.
//   • quote: only a bare `>` ADJACENT to a real quote line (before or after,
//     same fence region) — the shape the old serializer produced. An isolated
//     `>` paragraph the user typed stays a paragraph.
//   • never inside a fenced region (code/html may legally contain such text);
//     the closed-fence rule mirrors the scanners: an unclosed opener is prose.
//   • idempotent and pure. Applied at read boundaries only (editor load /
//     remote setDoc, blocksFromBody, share renderMarkdown) — persisted lazily
//     when the user next saves; stored bodies are never mass-rewritten (a
//     write migration would churn every synced peer for a cosmetic fix).

import { RE, isFenceClose, matchQuoteLine } from "./grammar.ts";

/** `- [ ]` / `- [x]` (any list glyph, any indent) with nothing after the `]`. */
const LEGACY_EMPTY_TODO = /^[ \t]*[-*+][ \t]+\[[ xX]\]$/;
const BARE_QUOTE = /^[ \t]*>$/;
/** Fast bail: any line that IS one of the two legacy forms. */
const MAYBE_LEGACY = /^[ \t]*(?:[-*+][ \t]+\[[ xX]\]|>)$/m;

/** Lines covered by a CLOSED fence (opener + matching closer), as a boolean
 *  mask. Mirrors the scanners' rule; tables/media lines can't collide with the
 *  legacy patterns (whole-line matches), so fences are the only voids that
 *  matter here. */
function fenceMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(RE.fenceOpen);
    if (!m) continue;
    const ch = m[1]![0]!;
    const len = m[1]!.length;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (isFenceClose(lines[j]!, ch, len)) {
        close = j;
        break;
      }
    }
    if (close === -1) continue; // unclosed opener is prose — healable region
    for (let j = i; j <= close; j++) mask[j] = true;
    i = close;
  }
  return mask;
}

export function healLegacyMarkdown(src: string): string {
  if (!MAYBE_LEGACY.test(src)) return src;
  const lines = src.split("\n");
  const inFence = fenceMask(lines);
  const quoteish = (i: number): boolean =>
    i >= 0 && i < lines.length && !inFence[i] &&
    matchQuoteLine(lines[i]!.replace(/^[ \t]*/, "")) !== null;

  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const line = lines[i]!;
    if (LEGACY_EMPTY_TODO.test(line)) {
      lines[i] = line + " ";
      changed = true;
    } else if (BARE_QUOTE.test(line) && (quoteish(i - 1) || quoteish(i + 1))) {
      // Top-down pass: a healed `>` becomes `> `, so a RUN of bare `>`s inside
      // a quote heals transitively via the quoteish(i - 1) check.
      lines[i] = line + " ";
      changed = true;
    }
  }
  return changed ? lines.join("\n") : src;
}
