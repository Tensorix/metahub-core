// Ordered lists on the share page carry each item's LITERAL number as an <li
// value> — the editor treats source numbers as authoritative (1,1,7 shows as
// 1,1,7), and the share page must match instead of letting the browser
// renumber sequentially.
import { test, expect } from "bun:test";
import { renderMarkdown } from "./share-render";

test("ordered items keep their literal numbers via <li value>", () => {
  expect(renderMarkdown("1. a\n1. b\n7. c")).toBe(
    '<ol><li value="1">a</li><li value="1">b</li><li value="7">c</li></ol>',
  );
});

test("the ) separator and multi-digit numbers work", () => {
  expect(renderMarkdown("10) x\n11) y")).toBe('<ol><li value="10">x</li><li value="11">y</li></ol>');
});

test("unordered items carry no value attribute", () => {
  expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
});
