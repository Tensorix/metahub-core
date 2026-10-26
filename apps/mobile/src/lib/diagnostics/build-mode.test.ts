import { expect, test } from "bun:test";
import { diagnosticsEnabled } from "./build-mode";

test("Release diagnostics need both explicit selectors", () => {
  expect(diagnosticsEnabled(false)).toBe(false);
  expect(diagnosticsEnabled(false, "1")).toBe(false);
  expect(diagnosticsEnabled(false, undefined, "1")).toBe(false);
  expect(diagnosticsEnabled(false, "1", "1")).toBe(true);
  expect(diagnosticsEnabled(false, "0", "1")).toBe(false);
});

test("development diagnostics retain the explicit selftest flag", () => {
  expect(diagnosticsEnabled(true)).toBe(false);
  expect(diagnosticsEnabled(true, "1")).toBe(true);
});
