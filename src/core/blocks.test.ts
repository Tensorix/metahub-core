import { test, expect } from "bun:test";
import {
  parseBlocks,
  serializeBlocks,
  parseDocBlocks,
  serializeDocBlocks,
  reconcile,
} from "./blocks.ts";

test("splits paragraphs on blank lines", () => {
  expect(parseBlocks("a\n\nb\n\nc")).toEqual(["a", "b", "c"]);
});

test("collapses blank runs and trims edges", () => {
  expect(parseBlocks("\n\n# Title\n\n\n\npara one\n\n")).toEqual([
    "# Title",
    "para one",
  ]);
});

test("multi-line paragraph stays one block", () => {
  expect(parseBlocks("line one\nline two\n\nnext")).toEqual([
    "line one\nline two",
    "next",
  ]);
});

test("fenced code block keeps internal blank lines as one block", () => {
  const md = "intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\noutro";
  expect(parseBlocks(md)).toEqual([
    "intro",
    "```ts\nconst a = 1;\n\nconst b = 2;\n```",
    "outro",
  ]);
});

test("tilde fences and adjacent fences", () => {
  const md = "~~~\na\n\nb\n~~~\n\n```\nc\n```";
  expect(parseBlocks(md)).toEqual(["~~~\na\n\nb\n~~~", "```\nc\n```"]);
});

test("empty input yields no blocks", () => {
  expect(parseBlocks("")).toEqual([]);
  expect(parseBlocks("\n\n  \n")).toEqual([]);
});

test("serialize joins with a blank line and drops empties", () => {
  expect(serializeBlocks(["a", "b", "c"])).toBe("a\n\nb\n\nc");
  expect(serializeBlocks(["a", "", null, "b"])).toBe("a\n\nb");
});

test("parse/serialize round-trips for varied content", () => {
  for (const md of [
    "a\n\nb\n\nc",
    "# H\n\npara\n\n```\ncode\n\nmore\n```\n\nend",
    "single",
    "line one\nline two\n\n- item\n- item",
  ]) {
    const blocks = parseBlocks(md);
    // serialize -> parse is the identity on the parsed block list
    expect(parseBlocks(serializeBlocks(blocks))).toEqual(blocks);
    // serialize is idempotent through a second parse
    expect(serializeBlocks(parseBlocks(serializeBlocks(blocks)))).toBe(
      serializeBlocks(blocks),
    );
  }
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
  // gap-free serialization matches the canonical join
  expect(serializeDocBlocks([{ text: "a", blankAfter: 0 }, { text: "b", blankAfter: 0 }, { text: "c", blankAfter: 0 }]))
    .toBe(serializeBlocks(["a", "b", "c"]));
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
