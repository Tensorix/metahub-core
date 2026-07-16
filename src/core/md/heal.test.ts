// healLegacyMarkdown: pre-strict-grammar legacy forms (empty todos `- [ ]`,
// bare-`>` quote gaps) regain the serializer's canonical trailing space at
// every READ boundary (editor load, blocksFromBody, share render), WITHOUT
// relaxing the strict grammar — non-empty bullet content, fence/table
// interiors, mid-typing forms, and user-typed isolated `>` paragraphs stay
// byte-identical.
import { test, expect, describe } from "bun:test";
import { healLegacyMarkdown } from "./heal";
import { scanDoc } from "../../webui/cm6/blockmodel";

describe("healLegacyMarkdown", () => {
  test("bare empty todo gains the canonical trailing space", () => {
    expect(healLegacyMarkdown("- [ ]")).toBe("- [ ] ");
    expect(healLegacyMarkdown("- [x]")).toBe("- [x] ");
    expect(healLegacyMarkdown("- [X]")).toBe("- [X] ");
    expect(healLegacyMarkdown("* [ ]")).toBe("* [ ] ");
  });

  test("healed line scans as an empty todo", () => {
    const healed = healLegacyMarkdown("- [ ]");
    const line = scanDoc(healed).lines[0]!;
    expect(line.role).toBe("todo");
    expect(line.contentFrom).toBe(line.to);
  });

  test("nested / indented legacy todos heal too", () => {
    expect(healLegacyMarkdown("- a\n  - [ ]")).toBe("- a\n  - [ ] ");
  });

  test("canonical and non-empty forms are untouched (idempotent)", () => {
    const canonical = "- [ ] \n- [x] done\n- bullet\n- [ ]x\npara [ ]";
    expect(healLegacyMarkdown(canonical)).toBe(canonical);
    const healed = healLegacyMarkdown("- [ ]\n- [x]");
    expect(healLegacyMarkdown(healed)).toBe(healed);
  });

  test("lines inside a code fence are never rewritten", () => {
    const src = "```\n- [ ]\n```";
    expect(healLegacyMarkdown(src)).toBe(src);
  });

  test("mixed doc: only the legacy line changes", () => {
    const src = "# t\n\n- [ ]\n- [ ] real\n\n> q";
    expect(healLegacyMarkdown(src)).toBe("# t\n\n- [ ] \n- [ ] real\n\n> q");
  });

  test("no-op fast path returns the same reference", () => {
    const src = "hello\n- bullet";
    expect(healLegacyMarkdown(src)).toBe(src);
  });
});

// ---- legacy bare-`>` quote gaps ----
// The old serializer wrote `>` (no space) for an empty line inside a quote
// block; strict grammar reads it as a paragraph, splitting the quote. Heal
// only when adjacent to a real quote line — an isolated `>` the user typed is
// a legitimate paragraph and must survive byte-identical.
import { renderMarkdown } from "../sync/share-render";
import { blocksFromBody } from "../../webui/blocks";

describe("healLegacyMarkdown: bare-> quote gaps", () => {
  test("legacy quote sandwich heals into one quote block", () => {
    expect(healLegacyMarkdown("> a\n>\n> b")).toBe("> a\n> \n> b");
  });

  test("a RUN of bare > lines inside a quote heals transitively", () => {
    expect(healLegacyMarkdown("> a\n>\n>\n> b")).toBe("> a\n> \n> \n> b");
  });

  test("a RUN of bare > at the START of a quote heals upward off the first quote line", () => {
    // No quote line above the run — the top-down pass alone leaves the first
    // line(s) bare; the backward pass propagates the heal up the whole run.
    expect(healLegacyMarkdown(">\n>\n> b")).toBe("> \n> \n> b");
    expect(healLegacyMarkdown(">\n>\n>\n> b")).toBe("> \n> \n> \n> b");
  });

  test("leading/trailing bare > adjacent to a quote line heals", () => {
    expect(healLegacyMarkdown(">\n> b")).toBe("> \n> b");
    expect(healLegacyMarkdown("> a\n>")).toBe("> a\n> ");
  });

  test("isolated > (user-typed paragraph) is untouched", () => {
    const src = "para\n>\npara";
    expect(healLegacyMarkdown(src)).toBe(src);
  });

  test("bare > inside a code fence is untouched", () => {
    const src = "> a\n```\n>\n```";
    expect(healLegacyMarkdown(src)).toBe(src);
  });

  test("indented legacy quote gap (nested under a list) heals with its pad", () => {
    expect(healLegacyMarkdown("  > a\n  >\n  > b")).toBe("  > a\n  > \n  > b");
  });

  test("idempotent", () => {
    const once = healLegacyMarkdown("> a\n>\n> b");
    expect(healLegacyMarkdown(once)).toBe(once);
  });

  test("at-rest surfaces see ONE quote for a legacy sandwich", () => {
    const legacy = "> a\n>\n> b";
    // editor load path heals before scanDoc sees it (CmDocBody norm)
    const roles = scanDoc(healLegacyMarkdown(legacy)).lines.map((l) => l.role);
    expect(roles).toEqual(["quote", "quote", "quote"]);
    // block tree of the HEALED text (blocksFromBody itself serves live editor
    // text and deliberately does not heal — its at-rest inputs arrive healed)
    const blocks = blocksFromBody(healLegacyMarkdown(legacy));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("quote");
    // share renderer heals internally: one blockquote, no literal ">" paragraph
    const html = renderMarkdown(legacy);
    expect(html.match(/<blockquote>/g)?.length).toBe(1);
    expect(html).not.toContain("<p>&gt;</p>");
  });
});
