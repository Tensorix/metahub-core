import { expect, test } from "bun:test";
import { fnv1a32, fnv1a64Hex } from "./hash.ts";
import { winnersDigest } from "./sync/partition.ts";

test("shared FNV helpers keep their wire-compatible golden values", () => {
  expect(fnv1a32("hello")).toBe(0x4f9f2cab);
  expect(fnv1a64Hex("hello")).toBe("a430d84680aabd0b");
});

test("partition digest stays byte-compatible after using the shared FNV helper", () => {
  expect(
    winnersDigest([
      {
        dataset: "records",
        row_id: "rec_a",
        col: "p1",
        hlc: "000000000000001-0000-n",
      },
      {
        dataset: "records",
        row_id: "rec_a",
        col: "p2",
        hlc: "000000000000002-0000-n",
      },
    ]),
  ).toBe("414e1d50c17a09c9");
});
