// Ordered lists on the share page carry each item's LITERAL number as an <li
// value> — the editor treats source numbers as authoritative (1,1,7 shows as
// 1,1,7), and the share page must match instead of letting the browser
// renumber sequentially.
import { test, expect } from "bun:test";
import { renderMarkdown } from "./share-render";

test("an indented heading is still a heading (classification is indent-blind)", () => {
  expect(renderMarkdown("  # x")).toBe("<h1>x</h1>");
  expect(renderMarkdown("    ## y")).toBe("<h2>y</h2>");
});

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

test("a doclink renders as INERT text on share pages (never a capability leak)", () => {
  // With a resolver: live title, but a <span>, not a link.
  const withResolver = renderMarkdown("see [[doc_notes-abc123]]", {
    resolveDocLink: (id) => (id === "doc_notes-abc123" ? { title: "会议纪要" } : null),
  });
  expect(withResolver).toBe('<p>see <span class="mh-doclink">会议纪要</span></p>');
  expect(withResolver).not.toContain("<a");
  // Explicit alias wins over the resolved title.
  expect(
    renderMarkdown("[[doc_notes-abc123|别名]]", { resolveDocLink: () => ({ title: "会议纪要" }) }),
  ).toContain(">别名</span>");
  // No resolver (static E2EE viewer) degrades to the id; unresolved ids too.
  expect(renderMarkdown("[[doc_notes-abc123]]")).toContain(">doc_notes-abc123</span>");
  expect(renderMarkdown("[[doc_gone-zzz999]]", { resolveDocLink: () => null })).toContain(
    ">doc_gone-zzz999</span>",
  );
  // A hostile "title" from a renamed doc is escaped.
  expect(
    renderMarkdown("[[doc_notes-abc123]]", { resolveDocLink: () => ({ title: '<img onerror=x>' }) }),
  ).not.toContain("<img");
});
