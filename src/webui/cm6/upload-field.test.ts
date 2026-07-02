// Headless contract tests for uploadField (chrome/upload-field.ts): pending
// entries are pure state, positions remap through doc changes (assoc 1), and
// stripStaleUploadLines removes the old pipeline's persisted placeholder junk.
// No DOM needed: decorations are only materialized by a live EditorView, and
// upload-field deliberately imports no Preact/ui.tsx.

import { test, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import {
  uploadField,
  addUpload,
  removeUpload,
  pendingUploads,
  stripStaleUploadLines,
} from "./chrome/upload-field";

const DOC = "alpha\nbeta\ngamma";

function withUpload(pos: number): EditorState {
  const base = EditorState.create({ doc: DOC, extensions: [uploadField] });
  return base.update({ effects: addUpload.of({ token: "t1", name: "a.png", pos }) }).state;
}

test("add effect registers a pending upload at pos", () => {
  const state = withUpload(5);
  expect(pendingUploads(state)).toEqual([{ token: "t1", name: "a.png", pos: 5 }]);
});

test("insert before pos shifts it right", () => {
  const state = withUpload(5).update({ changes: { from: 0, insert: "XX" } }).state;
  expect(pendingUploads(state)[0]!.pos).toBe(7);
});

test("insert exactly at pos pushes it right (assoc 1)", () => {
  const state = withUpload(5).update({ changes: { from: 5, insert: "Y" } }).state;
  expect(pendingUploads(state)[0]!.pos).toBe(6);
});

test("delete range containing pos collapses it to the deletion point", () => {
  const state = withUpload(5).update({ changes: { from: 3, to: 8, insert: "" } }).state;
  expect(pendingUploads(state)[0]!.pos).toBe(3);
});

test("insert after pos leaves it alone", () => {
  const state = withUpload(5).update({ changes: { from: 10, insert: "ZZ" } }).state;
  expect(pendingUploads(state)[0]!.pos).toBe(5);
});

test("remove effect drops the entry by token", () => {
  const state = withUpload(5).update({ effects: removeUpload.of("t1") }).state;
  expect(pendingUploads(state)).toEqual([]);
});

test("remove of an unknown token is a no-op", () => {
  const state = withUpload(5).update({ effects: removeUpload.of("nope") }).state;
  expect(pendingUploads(state)).toHaveLength(1);
});

test("multiple uploads coexist and remap independently", () => {
  let state = withUpload(5);
  state = state.update({ effects: addUpload.of({ token: "t2", name: "b.mp4", pos: 10 }) }).state;
  state = state.update({ changes: { from: 0, insert: "!!" } }).state;
  expect(pendingUploads(state).map((u) => u.pos)).toEqual([7, 12]);
  state = state.update({ effects: removeUpload.of("t1") }).state;
  expect(pendingUploads(state)).toEqual([{ token: "t2", name: "b.mp4", pos: 12 }]);
});

// ---- stripStaleUploadLines --------------------------------------------------

const JUNK = "⏳ 正在上传 pic.png… <!--mh-up:m3x9k2-1-abc123-->";

test("strip: middle junk line removed with its newline", () => {
  expect(stripStaleUploadLines(`one\n${JUNK}\ntwo`)).toBe("one\ntwo");
});

test("strip: junk as first line", () => {
  expect(stripStaleUploadLines(`${JUNK}\nrest`)).toBe("rest");
});

test("strip: junk as last line without trailing newline", () => {
  expect(stripStaleUploadLines(`head\n${JUNK}`)).toBe("head");
});

test("strip: junk-only doc becomes empty", () => {
  expect(stripStaleUploadLines(JUNK)).toBe("");
});

test("strip: doc trailing newline preserved", () => {
  expect(stripStaleUploadLines(`one\n${JUNK}\n`)).toBe("one\n");
});

test("strip: any line carrying the marker comment is junk, even inside inline code", () => {
  // The marker is machine-generated — a doc line containing the full comment is
  // junk by construction, so it is removed even wrapped in backticks.
  expect(stripStaleUploadLines("keep\n`<!--mh-up:abc-->` inline\nkeep2")).toBe("keep\nkeep2");
});

test("strip: plain 'mh-up' prose without the comment marker survives", () => {
  const doc = "talking about mh-up: tokens here\nand `mh-up` too";
  expect(stripStaleUploadLines(doc)).toBe(doc);
});

test("strip: untouched doc returned as-is, multi-line integrity preserved", () => {
  const doc = "a\n\nb\n- list\n\n```\ncode\n```\n";
  expect(stripStaleUploadLines(doc)).toBe(doc);
});
