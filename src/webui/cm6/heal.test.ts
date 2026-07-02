// healLegacyTodoLines: pre-strict-grammar empty todos (`- [ ]`, no trailing
// space) regain the serializer's canonical trailing space at the editor load
// boundary, WITHOUT relaxing the strict grammar — non-empty bullet content,
// fence/table interiors, and mid-typing forms stay byte-identical.
import { test, expect, describe } from "bun:test";
import { healLegacyTodoLines } from "./heal";
import { scanDoc } from "./blockmodel";

describe("healLegacyTodoLines", () => {
  test("bare empty todo gains the canonical trailing space", () => {
    expect(healLegacyTodoLines("- [ ]")).toBe("- [ ] ");
    expect(healLegacyTodoLines("- [x]")).toBe("- [x] ");
    expect(healLegacyTodoLines("- [X]")).toBe("- [X] ");
    expect(healLegacyTodoLines("* [ ]")).toBe("* [ ] ");
  });

  test("healed line scans as an empty todo", () => {
    const healed = healLegacyTodoLines("- [ ]");
    const line = scanDoc(healed).lines[0]!;
    expect(line.role).toBe("todo");
    expect(line.contentFrom).toBe(line.to);
  });

  test("nested / indented legacy todos heal too", () => {
    expect(healLegacyTodoLines("- a\n  - [ ]")).toBe("- a\n  - [ ] ");
  });

  test("canonical and non-empty forms are untouched (idempotent)", () => {
    const canonical = "- [ ] \n- [x] done\n- bullet\n- [ ]x\npara [ ]";
    expect(healLegacyTodoLines(canonical)).toBe(canonical);
    const healed = healLegacyTodoLines("- [ ]\n- [x]");
    expect(healLegacyTodoLines(healed)).toBe(healed);
  });

  test("lines inside a code fence are never rewritten", () => {
    const src = "```\n- [ ]\n```";
    expect(healLegacyTodoLines(src)).toBe(src);
  });

  test("mixed doc: only the legacy line changes", () => {
    const src = "# t\n\n- [ ]\n- [ ] real\n\n> q";
    expect(healLegacyTodoLines(src)).toBe("# t\n\n- [ ] \n- [ ] real\n\n> q");
  });

  test("no-op fast path returns the same reference", () => {
    const src = "hello\n- bullet";
    expect(healLegacyTodoLines(src)).toBe(src);
  });
});
