import { test, expect } from "bun:test";
import { greet } from "./index.ts";

test("greet defaults to world", () => {
  expect(greet()).toBe("Hello, world!");
});

test("greet uses provided name", () => {
  expect(greet({ name: "Noah" })).toBe("Hello, Noah!");
});
