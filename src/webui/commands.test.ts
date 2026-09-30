import { test, expect } from "bun:test";
import { commandMatches } from "./commands.ts";

const settings = { label: "打开设置", en: "Open settings" };
const sidebar = { label: "折叠 / 展开侧栏", en: "Toggle sidebar" };

test("matches the localized label, the English name, or English initials", () => {
  expect(commandMatches(settings, "设置")).toBe(true);
  expect(commandMatches(settings, "settings")).toBe(true);
  expect(commandMatches(settings, "OPEN")).toBe(true);
  expect(commandMatches(settings, "os")).toBe(true);
  expect(commandMatches(sidebar, "ts")).toBe(true);
  expect(commandMatches(sidebar, "侧栏")).toBe(true);
  expect(commandMatches(settings, "sidebar")).toBe(false);
  expect(commandMatches(settings, "so")).toBe(false);
  expect(commandMatches(settings, "  ")).toBe(true);
});
