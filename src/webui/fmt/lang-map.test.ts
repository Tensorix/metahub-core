// Language → engine routing (fmt/lang-map.ts): the canFormat gate that decides
// which blocks get a 格式化 button, checked against the COMMON_LANGS registry
// so a newly added language can't silently fall through the map unreviewed.
import { test, expect } from "bun:test";
import { COMMON_LANGS } from "../blocks";
import { canFormat, langEngine } from "./lang-map";

test("routing for the headline languages", () => {
  expect(langEngine("json")).toBe("json");
  expect(langEngine("javascript")).toBe("core");
  expect(langEngine("typescript")).toBe("core");
  expect(langEngine("python")).toBe("ruff");
  expect(langEngine("go")).toBe("gofmt");
  expect(langEngine("cpp")).toBe("clang");
  expect(langEngine("rust")).toBe("reindent");
});

test("fence aliases resolve like their canonical ids", () => {
  expect(langEngine("js")).toBe("core");
  expect(langEngine("ts")).toBe("core");
  expect(langEngine("py")).toBe("ruff");
  expect(langEngine("yml")).toBe("core");
  expect(langEngine("golang")).toBe("gofmt");
});

test("lookup is case/whitespace tolerant", () => {
  expect(langEngine(" Python ")).toBe("ruff");
  expect(langEngine("JSON")).toBe("json");
});

test("gated-off languages have no engine", () => {
  for (const lang of ["", undefined, "ruby", "markdown", "makefile", "diff", "unknown-lang"]) {
    expect(langEngine(lang)).toBeNull();
    expect(canFormat(lang)).toBe(false);
  }
});

test("every COMMON_LANGS entry is a deliberate decision", () => {
  // Languages we format (any engine) vs. deliberately buttonless. If someone
  // adds a language to COMMON_LANGS, this forces a conscious routing choice.
  const buttonless = new Set(["", "markdown", "ruby", "makefile", "diff"]);
  for (const { id } of COMMON_LANGS) {
    if (buttonless.has(id)) expect(langEngine(id)).toBeNull();
    else expect(langEngine(id)).not.toBeNull();
  }
});
