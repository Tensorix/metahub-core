// Equivalence suite for the incremental rescan: for ANY edit, patchScan of the
// old model must produce the same model a full scanDoc of the new text would
// (ephemeral block ids aside). Directed cases cover the window-widening edge
// cases (fence pairing, table absorption, void-boundary splits); a seeded fuzz
// is the safety net. The fallback counter is asserted so the invariant can't
// pass by silently degrading to full rescans.

import { test, expect } from "bun:test";
import {
  scanDoc,
  patchScan,
  patchScanFallbacks,
  type DocModel,
  type Edit,
  type LineSource,
} from "./blockmodel";

// ---- harness ---------------------------------------------------------------

function srcOf(text: string): LineSource {
  const lines = text.split("\n");
  const froms: number[] = [];
  let off = 0;
  for (const l of lines) {
    froms.push(off);
    off += l.length + 1;
  }
  return {
    lineCount: lines.length,
    length: text.length,
    line: (n) => ({ from: froms[n - 1]!, to: froms[n - 1]! + lines[n - 1]!.length, text: lines[n - 1]! }),
  };
}

interface Change {
  from: number;
  to: number;
  insert: string;
}

/** Apply ascending, non-overlapping changes (OLD coords) to `text`; return the
 *  new text plus the CM-iterChanges-shaped Edit list. */
function makeEdits(text: string, changes: Change[]): { text2: string; edits: Edit[] } {
  let out = "";
  let prevEnd = 0;
  let bOff = 0;
  const edits: Edit[] = [];
  for (const c of changes) {
    out += text.slice(prevEnd, c.from);
    const fromB = c.from + bOff;
    out += c.insert;
    edits.push({ fromA: c.from, toA: c.to, fromB, toB: fromB + c.insert.length });
    bOff += c.insert.length - (c.to - c.from);
    prevEnd = c.to;
  }
  out += text.slice(prevEnd);
  return { text2: out, edits };
}

/** Drop per-scan-fresh fields: void block ids are freshly generated on every
 *  parse (genId), so an incremental rescan can never reproduce them. */
function strip(m: DocModel) {
  return {
    lines: m.lines,
    voids: m.voids.map((v) => ({ ...v, block: { ...v.block, id: "" } })),
    headings: m.headings,
  };
}

/** CORE INVARIANT: patchScan(scanDoc(text), edits) ≡ scanDoc(text2), and the
 *  incremental path actually ran (no silent fallback). Returns the patched
 *  model for extra assertions. */
function checkPatch(text: string, changes: Change[]): { prev: DocModel; patched: DocModel; text2: string } {
  const prev = scanDoc(text);
  const { text2, edits } = makeEdits(text, changes);
  const before = patchScanFallbacks;
  const patched = patchScan(prev, edits, srcOf(text2));
  expect(patchScanFallbacks).toBe(before);
  expect(strip(patched)).toEqual(strip(scanDoc(text2)));
  return { prev, patched, text2 };
}

// ---- directed cases ----------------------------------------------------------

const DOC = [
  "# Title",
  "",
  "Some *para* text",
  "- one",
  "1. first",
  "1. second",
  "",
  "```js",
  "x()",
  "```",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "> quote",
  "tail para",
].join("\n");

test("single-char insert in a paragraph", () => {
  const at = DOC.indexOf("para") + 2;
  checkPatch(DOC, [{ from: at, to: at, insert: "X" }]);
});

test("single-char delete in a paragraph", () => {
  const at = DOC.indexOf("para");
  checkPatch(DOC, [{ from: at, to: at + 1, insert: "" }]);
});

test("multi-line paste", () => {
  const at = DOC.indexOf("- one");
  checkPatch(DOC, [{ from: at, to: at, insert: "pasted 1\n\n## Pasted head\n- pasted item\n" }]);
});

test("edit inside a fence body", () => {
  const at = DOC.indexOf("x()") + 1;
  checkPatch(DOC, [{ from: at, to: at + 1, insert: "yz" }]);
});

test("typing ``` opens a fence that swallows lines below (pairs with a later fence line)", () => {
  // Insert an opener above the existing ```js fence: it pairs with the first
  // close-ish line below and swallows everything in between.
  const at = DOC.indexOf("Some");
  checkPatch(DOC, [{ from: at, to: at, insert: "```\n" }]);
});

test("typing ``` with no close below stays prose", () => {
  const at = DOC.indexOf("tail para");
  checkPatch(DOC, [{ from: at, to: at, insert: "```\n" }]);
});

test("a close-ish line typed below an UNMATCHED opener above forms the fence", () => {
  const text = "```ts\nstill prose\nmore prose\nend";
  // prev: unclosed fence opener → everything is prose. Typing ``` at the very
  // end pairs with the line-1 opener and swallows the doc.
  checkPatch(text, [{ from: text.length, to: text.length, insert: "\n```" }]);
});

test("deleting a closing fence line dissolves (or re-pairs) the fence", () => {
  const from = DOC.indexOf("```", DOC.indexOf("x()")); // the closing ``` line
  checkPatch(DOC, [{ from, to: from + 4, insert: "" }]); // incl. trailing \n
});

test("deleting a closing fence re-pairs with a close further below", () => {
  const text = "```a\nx\n```\ny\n```b\nz\n```\nw";
  const from = text.indexOf("```", text.indexOf("x")); // first close line
  checkPatch(text, [{ from, to: from + 4, insert: "" }]);
});

test("adding a delimiter row under a pipe paragraph forms a table", () => {
  const text = "intro\nA | B\nafter";
  const at = text.indexOf("\nafter");
  checkPatch(text, [{ from: at, to: at, insert: "\n| --- | --- |" }]);
});

test("deleting the table separator dissolves the table", () => {
  const from = DOC.indexOf("| --- | --- |");
  checkPatch(DOC, [{ from, to: from + "| --- | --- |\n".length, insert: "" }]);
});

test("typing a pipe row right below a table absorbs it", () => {
  const at = DOC.indexOf("| 1 | 2 |") + "| 1 | 2 |".length;
  checkPatch(DOC, [{ from: at, to: at, insert: "\n| 3 | 4 |" }]);
});

test("line merge at a void boundary (delete newline before fence opener)", () => {
  const nl = DOC.indexOf("\n```js");
  checkPatch(DOC, [{ from: nl, to: nl + 1, insert: "" }]);
});

test("line merge at a void boundary (delete newline after fence close)", () => {
  const close = DOC.indexOf("```", DOC.indexOf("x()"));
  const nl = close + 3;
  checkPatch(DOC, [{ from: nl, to: nl + 1, insert: "" }]);
});

test("line split just before a table (insert newline)", () => {
  const at = DOC.indexOf("| A | B |") - 1; // inside the preceding blank/newline area
  checkPatch(DOC, [{ from: at, to: at, insert: "\n" }]);
});

test("doc-start edit", () => {
  checkPatch(DOC, [{ from: 0, to: 0, insert: "new first line\n" }]);
  checkPatch(DOC, [{ from: 0, to: 2, insert: "" }]); // eat "# " → title becomes para
});

test("doc-end edit", () => {
  checkPatch(DOC, [{ from: DOC.length, to: DOC.length, insert: "\n- appended" }]);
  checkPatch(DOC, [{ from: DOC.length - 5, to: DOC.length, insert: "" }]);
});

test("one transaction with multiple ranges", () => {
  const a = DOC.indexOf("Title");
  const b = DOC.indexOf("x()");
  const c = DOC.indexOf("tail");
  checkPatch(DOC, [
    { from: a, to: a + 5, insert: "Renamed" },
    { from: b, to: b, insert: "y = " },
    { from: c, to: c + 4, insert: "TAIL" },
  ]);
});

test("empty document + growth from empty", () => {
  checkPatch("", [{ from: 0, to: 0, insert: "hello" }]);
  checkPatch("", [{ from: 0, to: 0, insert: "# h\n\n```\nc\n```" }]);
});

test("edit that changes heading text also changes the headings array", () => {
  const at = DOC.indexOf("Title");
  const { prev, patched, text2 } = checkPatch(DOC, [{ from: at, to: at, insert: "New " }]);
  expect(patched.headings).not.toBe(prev.headings);
  expect(patched.headings).toEqual(scanDoc(text2).headings);
  expect(patched.headings[0]!.text).toBe("New Title");
});

test("non-heading edit REUSES the previous headings array reference", () => {
  const at = DOC.indexOf("para");
  const { prev, patched } = checkPatch(DOC, [{ from: at, to: at, insert: "X" }]);
  expect(patched.headings).toBe(prev.headings); // === contract for consumers
});

test("chained patches (patch of a patched model) stay equivalent", () => {
  let text = DOC;
  let model = scanDoc(text);
  const steps: Change[] = [
    { from: DOC.indexOf("one"), to: DOC.indexOf("one") + 3, insert: "uno" },
    { from: 0, to: 0, insert: "```\n" },
    { from: 4, to: 8, insert: "" },
  ];
  for (const step of steps) {
    const { text2, edits } = makeEdits(text, [step]);
    model = patchScan(model, edits, srcOf(text2));
    expect(strip(model)).toEqual(strip(scanDoc(text2)));
    text = text2;
  }
});

// ---- seeded fuzz ------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = [
  "plain paragraph",
  "another para with `code` span",
  "",
  "",
  "- item",
  "  - nested",
  "1. first",
  "2. second",
  "# Head",
  "## Sub head",
  "> quoted",
  "---",
  "```",
  "```js",
  "~~~",
  "const x = 1",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
  "text with | pipe",
  "  | c | d |",
  "![img](/blob/pic.png?w=300)",
  "[doc.pdf](/blob/doc.pdf \"12\")",
];

const SNIPPETS = ["x", "|", "`", "```", "\n", "\n\n", "# ", "- ", "| --- |", "```\nz\n```", "~~~", " ", "]("];

test("fuzz: 200 random docs × random edits ≡ full rescan (seeded, no fallbacks)", () => {
  const rnd = mulberry32(0xc0ffee);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const before = patchScanFallbacks;

  for (let iter = 0; iter < 200; iter++) {
    const n = 3 + Math.floor(rnd() * 38);
    const docLines: string[] = [];
    for (let i = 0; i < n; i++) docLines.push(pick(VOCAB));
    let text = docLines.join("\n");
    let model = scanDoc(text);

    // two chained edits per doc: also exercises patchScan on a patched model
    for (let step = 0; step < 2; step++) {
      const kind = rnd();
      let change: Change;
      if (kind < 0.45) {
        // insert
        const at = Math.floor(rnd() * (text.length + 1));
        change = { from: at, to: at, insert: pick(SNIPPETS) };
      } else if (kind < 0.8) {
        // delete a small range
        const at = Math.floor(rnd() * (text.length + 1));
        const len = Math.min(text.length - at, Math.floor(rnd() * 12));
        change = { from: at, to: at + len, insert: "" };
      } else {
        // replace a range with a snippet
        const at = Math.floor(rnd() * (text.length + 1));
        const len = Math.min(text.length - at, Math.floor(rnd() * 8));
        change = { from: at, to: at + len, insert: pick(SNIPPETS) };
      }
      const { text2, edits } = makeEdits(text, [change]);
      const patched = patchScan(model, edits, srcOf(text2));
      const full = scanDoc(text2);
      // report the failing case deterministically
      if (JSON.stringify(strip(patched)) !== JSON.stringify(strip(full))) {
        console.error("fuzz mismatch", { iter, step, text: JSON.stringify(text), change });
      }
      expect(strip(patched)).toEqual(strip(full));
      text = text2;
      model = patched;
    }
  }
  expect(patchScanFallbacks).toBe(before);
});
