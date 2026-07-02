// Grammar parity across every rendering surface. The line grammar lives in
// webui/blocks.ts (RE + matchListLine + matchQuoteLine) and BOTH the CM6 editor
// render (scanDoc/classifyLine) and the share page (core/sync/share-render.ts)
// must classify a line exactly like the save parser (blocksFromBody) does —
// otherwise the same text renders as different block types in the editor, on
// the share page, and on other devices. Each sample pins the agreed
// classification on all three surfaces so any re-fork fails loudly.
//
// Strict semantics (approved): EVERY marker needs trailing whitespace — nothing
// renders as a block until the space commits it. `- `/`1. `/`> ` (empty items,
// the serializer's own output) are blocks; bare `-`/`1.`/`>` are the mid-typing
// paragraph state; `-foo`/`1.foo`/`>foo` are paragraphs.

import { test, expect } from "bun:test";
import { scanDoc } from "./blockmodel";
import { blocksFromBody } from "../blocks";
import { renderMarkdown } from "../../core/sync/share-render";

type Kind = "quote" | "bullet" | "numbered" | "p";

const CASES: [line: string, kind: Kind][] = [
  ["> x", "quote"],
  [">x", "p"],
  [">", "p"], // bare marker (mid-typing) — paragraph everywhere
  ["> ", "quote"], // empty quote line: marker + trailing space (serializer form)
  ["- x", "bullet"],
  ["-x", "p"],
  ["-", "p"], // bare marker (mid-typing) — paragraph everywhere
  ["- ", "bullet"], // empty item: marker + trailing space
  ["1. x", "numbered"],
  ["1.x", "p"],
  ["1.", "p"],
  ["1. ", "numbered"],
  ["* x", "bullet"],
  ["*x", "p"],
];

/** Opening tag renderMarkdown must emit for each kind. */
const HTML_TAG: Record<Kind, string> = {
  quote: "<blockquote",
  bullet: "<ul",
  numbered: "<ol",
  p: "<p",
};

for (const [line, kind] of CASES) {
  test(`parity: ${JSON.stringify(line)} is "${kind}" on editor, save, and share surfaces`, () => {
    // 1) CM6 editor render (scanDoc → LineInfo.role; roles share the kind names)
    expect(scanDoc(line).lines[0]!.role).toBe(kind);
    // 2) save/load parser (block type of the first parsed block)
    expect(blocksFromBody(line)[0]!.type).toBe(kind);
    // 3) share page renderer (block-level HTML tag)
    expect(renderMarkdown(line).startsWith(HTML_TAG[kind])).toBe(true);
  });
}
