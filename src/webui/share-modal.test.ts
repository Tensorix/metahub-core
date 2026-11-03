import { expect, test } from "bun:test";
import { draftToGrantSet, grantSetToDraft } from "./share-modal.tsx";
import type { GrantSet } from "./api.ts";

test("loading and saving a public grant set preserves existing permissions", () => {
  const grants: GrantSet = {
    v: 1,
    tables: [
      { db: "db_a", ops: ["read", "create"] },
      { db: "db_b", ops: ["read", "update"] },
    ],
  };
  expect(draftToGrantSet(grantSetToDraft(grants))).toEqual(grants);
});

test("a new link draft remains default-deny", () => {
  expect(draftToGrantSet(new Map())).toBeNull();
});

