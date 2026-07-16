// Incremental find recompute (remapMatches in chrome/find.tsx) must be
// EXTENSIONALLY EQUAL to a full re-search after every edit: kept matches map
// through the changes, the damaged window is re-searched, and the merge has no
// gaps, dupes, or stale wholeWord verdicts. Randomized equivalence against
// findInText over the whole new doc is the oracle.
//
// find.tsx pulls preact/icons at import time — register happy-dom (same
// pattern as void-field.test.ts).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { afterAll, test, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { findInText, type FindOpts } from "../find";
import { findField, openFind, setFind, remapMatches } from "./chrome/find";

afterAll(() => GlobalRegistrator.unregister());

function stateWith(doc: string, term: string, opts: FindOpts): EditorState {
  const base = EditorState.create({ doc, extensions: [findField] });
  return base.update({
    effects: [openFind.of(null), setFind.of({ term, opts })],
  }).state;
}

function afterEdit(
  state: EditorState,
  from: number,
  to: number,
  insert: string,
): Array<[number, number]> {
  const next = state.update({ changes: { from, to, insert } }).state;
  return next.field(findField)!.matches;
}

const OPTS: FindOpts[] = [
  { caseSensitive: false, wholeWord: false },
  { caseSensitive: true, wholeWord: false },
  { caseSensitive: false, wholeWord: true },
];

test("directed: edit far from matches keeps them (mapped)", () => {
  const doc = "abc abc abc\nfiller line\nabc";
  const st = stateWith(doc, "abc", OPTS[0]!);
  const got = afterEdit(st, 16, 16, "XY"); // inside "filler"
  const want = findInText("abc abc abcXYZ".replace("XYZ", "abc\nfillerXY line\nabc").slice(0), "abc", OPTS[0]!);
  // Oracle computed on the real new text:
  const newDoc = doc.slice(0, 16) + "XY" + doc.slice(16);
  expect(got).toEqual(findInText(newDoc, "abc", OPTS[0]!));
  void want;
});

test("directed: typing completes a match across the edit boundary", () => {
  const doc = "hello wor";
  const st = stateWith(doc, "world", OPTS[0]!);
  expect(st.field(findField)!.matches).toEqual([]);
  const got = afterEdit(st, 9, 9, "ld");
  expect(got).toEqual([[6, 11]]);
});

test("directed: deleting splits a match", () => {
  const doc = "say world twice world";
  const st = stateWith(doc, "world", OPTS[0]!);
  const got = afterEdit(st, 6, 8, ""); // "world" → "wld"
  const newDoc = "say wld twice world";
  expect(got).toEqual(findInText(newDoc, "world", OPTS[0]!));
});

test("directed: wholeWord verdict flips via a boundary char edit", () => {
  const doc = "cat catalog cat";
  const opts = OPTS[2]!;
  const st = stateWith(doc, "cat", opts);
  expect(st.field(findField)!.matches).toHaveLength(2);
  // Append "s" right after the first "cat" → "cats …": no longer whole-word.
  const got = afterEdit(st, 3, 3, "s");
  expect(got).toEqual(findInText("cats catalog cat", "cat", opts));
});

test("active match is tracked by identity when a new match is inserted before it", () => {
  // doc has two "abc"; the SECOND is active (idx 1). Insert a fresh "abc " at the
  // front → three matches; the active one must follow to its new index (2), not
  // stay at the stale positional idx 1 (which would highlight a different match).
  const base = EditorState.create({ doc: "abc def abc" });
  const tr = base.update({ changes: { from: 0, to: 0, insert: "abc " } });
  const prev = {
    term: "abc",
    opts: OPTS[0]!,
    idx: 1,
    matches: [[0, 3], [8, 11]] as Array<[number, number]>,
  };
  const next = remapMatches(prev as never, tr);
  expect(next.matches).toEqual([[0, 3], [4, 7], [12, 15]]);
  expect(next.idx).toBe(2);
  expect(next.matches[next.idx]).toEqual([12, 15]);
});

test("randomized equivalence across opts and edits", () => {
  // Deterministic PRNG (mulberry32) — reproducible failures.
  let seed = 0x12345678;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = "ab cAB\n世界";
  const randText = (n: number) => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
  for (let iter = 0; iter < 120; iter++) {
    const doc = randText(60 + Math.floor(rnd() * 80));
    const term = ["ab", "AB", "a", "世界", "b c"][Math.floor(rnd() * 5)]!;
    const opts = OPTS[Math.floor(rnd() * OPTS.length)]!;
    const st = stateWith(doc, term, opts);
    const from = Math.floor(rnd() * (doc.length + 1));
    const to = Math.min(doc.length, from + Math.floor(rnd() * 6));
    const insert = randText(Math.floor(rnd() * 6));
    const got = afterEdit(st, from, to, insert);
    const newDoc = doc.slice(0, from) + insert + doc.slice(to);
    expect(got).toEqual(findInText(newDoc, term, opts));
  }
});
