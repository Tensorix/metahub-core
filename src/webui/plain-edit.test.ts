// flattenToText needs a DOM; register happy-dom for this file only and
// unregister afterwards — bun test runs every file in one process, so a leaked
// global `document` would flip turndown (html-md.test.ts) off its bundled
// domino DOM. Same guard as markdown.dom.test.ts.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { afterAll, test, expect } from "bun:test";
import { deletePlainSelection, flattenToText, plainTextFrom } from "./plain-edit.ts";

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

// The title's Enter cuts [caret, end] before handing the tail to the body. Under
// happy-dom execCommand is unimplemented, so this exercises the Range fallback —
// the path a browser without execCommand would take.
test("deletePlainSelection removes the selected range, caret at the seam", () => {
  const el = document.createElement("div");
  el.textContent = "前半后半";
  document.body.append(el);
  const node = el.firstChild!;
  const r = document.createRange();
  r.setStart(node, 2);
  r.setEnd(node, 4);
  const sel = getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);

  deletePlainSelection();
  expect(el.textContent).toBe("前半");

  // A collapsed selection is a no-op — Enter at the title's end must not eat a
  // character on its way into the body.
  deletePlainSelection();
  expect(el.textContent).toBe("前半");
  el.remove();
});

// Regression: the title's Enter builds its cut range as (textNode, caret) →
// (host, childNodes.length). With the caret at the very end that range holds
// nothing, yet its boundaries live in different nodes, so `collapsed` is false
// — the shape that made deletePlainSelection backspace the title's last
// character. The guard must judge content, not boundary identity.
test("an empty cross-node range deletes nothing", () => {
  const el = document.createElement("div");
  el.textContent = "标题";
  document.body.append(el);
  const node = el.firstChild!;
  const r = document.createRange();
  r.setStart(node, 2);
  r.setEnd(el, el.childNodes.length);
  expect(r.collapsed).toBe(false); // the trap: empty range, still not "collapsed"
  const sel = getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);

  deletePlainSelection();
  expect(el.textContent).toBe("标题");
  el.remove();
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
