import { expect, test } from "bun:test";
import { draftToGrantSet, grantSetToDraft } from "./share-modal.tsx";

test("loading and saving a public grant set preserves existing permissions", () => {
  const grants = {
    v: 1 as const,
    tables: [
      { db: "db_a", ops: ["read", "create"] as const },
      { db: "db_b", ops: ["read", "update"] as const },
    ],
  };
  expect(draftToGrantSet(grantSetToDraft(grants))).toEqual(grants);
});

test("a new link draft remains default-deny", () => {
  expect(draftToGrantSet(new Map())).toBeNull();
});

