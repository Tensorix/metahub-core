// flattenToText needs a DOM; register happy-dom for this file only and
// unregister afterwards — bun test runs every file in one process, so a leaked
// global `document` would flip turndown (html-md.test.ts) off its bundled
// domino DOM. Same guard as markdown.dom.test.ts.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { afterAll, test, expect } from "bun:test";
import { flattenToText, plainTextFrom } from "./plain-edit.ts";

afterAll(() => GlobalRegistrator.unregister());

/** Minimal stand-in for the clipboard/drag payload the handlers read. */
function transfer(data: Record<string, string>): DataTransfer {
  return { getData: (t: string) => data[t] ?? "" } as unknown as DataTransfer;
}

test("a rich clipboard yields only its text/plain flavor", () => {
  const dt = transfer({
    "text/html": '<span style="font-size:11pt;font-weight:400">v96</span>',
    "text/plain": "v96",
  });
  expect(plainTextFrom(dt)).toBe("v96");
});

test("multi-line text folds to one line for a single-line host", () => {
  const dt = transfer({ "text/plain": "v96\n上次同步 16:08" });
  expect(plainTextFrom(dt)).toBe("v96 上次同步 16:08");
  expect(plainTextFrom(dt, { multiline: true })).toBe("v96\n上次同步 16:08");
});

test("CRLF normalizes and surrounding blank space is trimmed", () => {
  const dt = transfer({ "text/plain": "  a\r\n\tb  \r\n" });
  expect(plainTextFrom(dt)).toBe("a b");
});

test("an empty or absent transfer yields an empty string", () => {
  expect(plainTextFrom(transfer({}))).toBe("");
  expect(plainTextFrom(null)).toBe("");
});

test("flattenToText collapses nested markup, leaves plain text alone", () => {
  const el = document.createElement("div");
  el.innerHTML = '<span style="font-size:11pt">v96</span><div>tail</div>';
  flattenToText(el);
  expect(el.innerHTML).toBe("v96tail");
  expect(el.firstElementChild).toBe(null);

  const plain = document.createElement("div");
  plain.textContent = "v96";
  flattenToText(plain);
  expect(plain.textContent).toBe("v96");
});
