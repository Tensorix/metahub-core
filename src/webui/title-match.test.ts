import { test, expect } from "bun:test";
import { matchTitles } from "./title-match.ts";

const ALL = [
  { id: "doc_design-notes-a1", title: "Design Notes" },
  { id: "db_tasks-b2", title: "Tasks" },
  { id: "doc_x-c3", title: "设计笔记" },
  { id: "doc_redesign-d4", title: "Redesign plan" },
];

test("prefix beats substring; spans point at the matched text; case-insensitive", () => {
  expect(matchTitles("des", 8, ALL)).toEqual([
    { id: "doc_design-notes-a1", title: "Design Notes", start: 0, len: 3 },
    { id: "doc_redesign-d4", title: "Redesign plan", start: 2, len: 3 },
  ]);
  expect(matchTitles("设计", 8, ALL)).toEqual([{ id: "doc_x-c3", title: "设计笔记", start: 0, len: 2 }]);
});

test("an exact title outranks a prefix match", () => {
  const all = [{ id: "doc_tasks-notes-1", title: "Tasks notes" }, { id: "db_tasks-2", title: "Tasks" }];
  expect(matchTitles("tasks", 8, all).map((m) => m.id)).toEqual(["db_tasks-2", "doc_tasks-notes-1"]);
});

test("id matches rank like title matches but carry no span; limit and empty query", () => {
  expect(matchTitles("db_ta", 8, ALL)).toEqual([{ id: "db_tasks-b2", title: "Tasks", start: -1, len: 0 }]);
  expect(matchTitles("c3", 8, ALL)).toEqual([{ id: "doc_x-c3", title: "设计笔记", start: -1, len: 0 }]);
  expect(matchTitles("", 2, ALL).map((m) => m.id)).toEqual(["doc_design-notes-a1", "db_tasks-b2"]);
  expect(matchTitles("zzz", 8, ALL)).toEqual([]);
});
