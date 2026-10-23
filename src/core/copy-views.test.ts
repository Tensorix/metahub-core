import { test, expect } from "bun:test";
import { copyViews } from "./copy-views.ts";

test("view copying preserves external references, extensions and malformed values", () => {
  const raw = [
    null,
    7,
    {
      id: "v1",
      extension: "old",
      end: "old",
      filter: {
        rules: [
          { prop: "external", value: ["row"] },
          { prop: "self", value: ["row", "missing"] },
          null,
        ],
      },
    },
  ];
  expect(
    copyViews(
      raw,
      new Map([
        ["old", "new"],
        ["external", "ext2"],
        ["self", "self2"],
      ]),
      new Map([["row", "row2"]]),
      new Set(["self"]),
    ),
  ).toEqual([
    null,
    7,
    {
      id: "v1",
      extension: "old",
      end: "new",
      filter: {
        rules: [
          { prop: "ext2", value: ["row"] },
          { prop: "self2", value: ["row2", "missing"] },
          null,
        ],
      },
    },
  ]);
  expect(copyViews(null, new Map(), new Map(), new Set())).toBeNull();
});
