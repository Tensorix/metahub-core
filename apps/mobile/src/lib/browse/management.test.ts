import { describe, expect, test } from "bun:test";
import {
  adjacentAnchor,
  manualOrderAllowed,
  mergeView,
  documentPageRows,
} from "./management";
import { emptyView } from "../../../../../src/shared/views/model.ts";
describe("mobile management integrity", () => {
  test("document pages expose children even when their parent lives outside the page", () => {
    const docs = [
      { id: "child", parent_id: "parent-on-other-page", database_id: null },
      { id: "db-document", parent_id: null, database_id: "db" },
    ];
    expect(documentPageRows(docs).map((row) => row.doc.id)).toEqual([
      "child",
      "db-document",
    ]);
    expect(
      documentPageRows(docs).every(
        (row) => !row.hasChildren && row.depth === 0,
      ),
    ).toBe(true);
  });
  test("editing one view retains unsupported layouts and opaque configuration", () => {
    const original = {
      ...emptyView("table", "Old", "a"),
      plugin: { enabled: true },
    };
    const unsupported = { id: "future", layout: "gallery", plugin: { x: 1 } };
    const next = { ...original, name: "Updated" };
    const merged = mergeView([original, unsupported], [], next);
    expect(merged[1]).toBe(unsupported);
    expect(merged[0]).toEqual({ ...original, name: "Updated" });
  });
  test("concurrent newly added views survive a stale editor save", () => {
    const first = emptyView("table", "A", "a"),
      concurrent = emptyView("board", "B", "b");
    expect(
      mergeView([first, concurrent], [first], { ...first, name: "Renamed" }),
    ).toEqual([{ ...first, name: "Renamed" }, concurrent]);
  });
  test("unfiltered canonical order alone enables manual movement", () => {
    expect(manualOrderAllowed("  ", [], [])).toBe(true);
    expect(manualOrderAllowed("text", [], [])).toBe(false);
    expect(manualOrderAllowed("", [{}], [])).toBe(false);
    expect(manualOrderAllowed("", [], [{}])).toBe(false);
  });
  test("page edge uses adjacent canonical anchor without truncating database order", () => {
    const page = [{ id: "page-first" }, { id: "page-last" }],
      previous = { id: "previous-page-last" },
      next = { id: "next-page-first" };
    expect(adjacentAnchor(page, "page-first", "up", previous, next)).toBe(
      previous,
    );
    expect(adjacentAnchor(page, "page-last", "down", previous, next)).toBe(
      next,
    );
    expect(adjacentAnchor(page, "page-first", "down", previous, next)).toBe(
      page[1],
    );
    expect(
      adjacentAnchor(page, "missing", "down", previous, next),
    ).toBeUndefined();
  });
});
