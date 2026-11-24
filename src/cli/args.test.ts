import { test, expect } from "bun:test";
import { MhError } from "../core/errors.ts";
import { parseCommaList, parseIntArg } from "./args.ts";

test("parseIntArg accepts integers and rejects junk", () => {
  expect(parseIntArg(undefined, "--limit")).toBeUndefined();
  expect(parseIntArg("10", "--limit")).toBe(10);
  expect(parseIntArg("0", "--keep")).toBe(0);
  expect(() => parseIntArg("abc", "--limit")).toThrow(MhError);
  expect(() => parseIntArg("1.5", "--limit")).toThrow(MhError);
  expect(() => parseIntArg("-1", "--limit")).toThrow(MhError);
  expect(() => parseIntArg("0", "--limit", { min: 1 })).toThrow(MhError);
  try {
    parseIntArg("nope", "--limit");
  } catch (e) {
    expect(e).toBeInstanceOf(MhError);
    expect((e as MhError).code).toBe("invalid_input");
  }
});

test("parseCommaList splits and rejects empty", () => {
  expect(parseCommaList(undefined, "--unset")).toEqual([]);
  expect(parseCommaList("a, b ,c", "--unset")).toEqual(["a", "b", "c"]);
  expect(() => parseCommaList(" , ", "--unset")).toThrow(MhError);
});
