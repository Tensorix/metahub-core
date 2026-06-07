import { test, expect } from "bun:test";
import {
  parseDocBlocks,
  serializeDocBlocks,
  reconcile,
} from "./blocks.ts";

test("parseDocBlocks block splitting: multi-line paragraphs, ~~~/``` fences, empty input", () => {
  // a multi-line paragraph stays one block
  expect(parseDocBlocks("line one\nline two\n\nnext").map((b) => b.text)).toEqual([
    "line one\nline two",
    "next",
  ]);
  // tilde and backtick fences each stay whole; internal blank lines don't split
  expect(parseDocBlocks("~~~\na\n\nb\n~~~\n\n```\nc\n```").map((b) => b.text)).toEqual([
    "~~~\na\n\nb\n~~~",
    "```\nc\n```",
  ]);
  // leading blanks trimmed; empty / whitespace-only input yields no blocks
  expect(parseDocBlocks("\n\n# Title\n\npara").map((b) => b.text)).toEqual(["# Title", "para"]);
  expect(parseDocBlocks("")).toEqual([]);
  expect(parseDocBlocks("\n\n  \n")).toEqual([]);
});

test("parseDocBlocks records extra blank lines beyond the separator", () => {
  // one blank line = standard separator (blankAfter 0)
  expect(parseDocBlocks("a\n\nb")).toEqual([
    { text: "a", blankAfter: 0 },
    { text: "b", blankAfter: 0 },
  ]);
  // two blank lines between = 1 extra; trailing run counts in full on the last block
  expect(parseDocBlocks("a\n\n\nb\n\n")).toEqual([
    { text: "a", blankAfter: 1 },
    { text: "b", blankAfter: 2 },
  ]);
  // leading blank lines are dropped
  expect(parseDocBlocks("\n\na")).toEqual([{ text: "a", blankAfter: 0 }]);
});

test("serializeDocBlocks re-emits kept blank-line runs", () => {
  expect(serializeDocBlocks([{ text: "a", blankAfter: 0 }, { text: "b", blankAfter: 0 }])).toBe("a\n\nb");
  expect(serializeDocBlocks([{ text: "a", blankAfter: 1 }, { text: "b", blankAfter: 2 }])).toBe("a\n\n\nb\n\n");
  // gap-free serialization is the canonical single-blank join
  expect(serializeDocBlocks([{ text: "a", blankAfter: 0 }, { text: "b", blankAfter: 0 }, { text: "c", blankAfter: 0 }]))
    .toBe("a\n\nb\n\nc");
});

test("doc-block blank runs round-trip and stay idempotent", () => {
  for (const md of [
    "a\n\n\nb",            // interior extra blank line
    "keep\n\n",            // trailing blank line
    "x\n\n\n\ny\n\n\n",    // multiple interior + trailing
    "intro\n\n```ts\nq\n\nw\n```\n\n\nend", // fence with extra blank after
  ]) {
    const blocks = parseDocBlocks(md);
    expect(serializeDocBlocks(blocks)).toBe(md);
    expect(parseDocBlocks(serializeDocBlocks(blocks))).toEqual(blocks);
  }
});

test("reconcile keeps unchanged blocks and marks inserts/deletes", () => {
  const plan = reconcile(["a", "b", "c"], ["a", "X", "c"]);
  expect(plan.items).toEqual([{ keep: 0 }, { insert: "X" }, { keep: 2 }]);
  expect(plan.deleted).toEqual([1]);
});

test("reconcile pure insert at end", () => {
  const plan = reconcile(["a", "b"], ["a", "b", "c"]);
  expect(plan.items).toEqual([{ keep: 0 }, { keep: 1 }, { insert: "c" }]);
  expect(plan.deleted).toEqual([]);
});

test("reconcile pure delete", () => {
  const plan = reconcile(["a", "b", "c"], ["a", "c"]);
  expect(plan.items).toEqual([{ keep: 0 }, { keep: 2 }]);
  expect(plan.deleted).toEqual([1]);
});

test("reconcile empty new clears everything", () => {
  const plan = reconcile(["a", "b"], []);
  expect(plan.items).toEqual([]);
  expect(plan.deleted).toEqual([0, 1]);
});
