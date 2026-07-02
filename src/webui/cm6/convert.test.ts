// turnIntoChanges — pure "turn into" conversion over scanDoc fixtures.
// Changes are applied by hand (sort + splice) so no EditorView is needed.

import { test, expect, describe } from "bun:test";
import { scanDoc } from "./blockmodel";
import { turnIntoChanges, type TargetType, type LineChange } from "./convert";

/** Apply LineChanges to `src` the way CM would: all offsets are pre-change. */
function apply(src: string, changes: LineChange[]): string {
  const sorted = [...changes].sort((a, b) => a.from - b.from || a.to - b.to);
  let out = "";
  let pos = 0;
  for (const c of sorted) {
    out += src.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + src.slice(pos);
}

/** Convert and return the resulting document, or null when nothing changed. */
function convert(src: string, fromLine: number, toLine: number, type: TargetType): string | null {
  const m = scanDoc(src);
  const changes = turnIntoChanges(m.lines, m.voids, (f, t) => src.slice(f, t), fromLine, toLine, type);
  return changes ? apply(src, changes) : null;
}

describe("turnIntoChanges", () => {
  test("p → h2", () => {
    expect(convert("hello", 1, 1, "h2")).toBe("## hello");
  });

  test("h1 → quote strips old marker", () => {
    expect(convert("# title", 1, 1, "quote")).toBe("> title");
  });

  test("todo → bullet and back", () => {
    expect(convert("- [ ] task", 1, 1, "bullet")).toBe("- task");
    expect(convert("- [x] done", 1, 1, "bullet")).toBe("- done");
    expect(convert("- task", 1, 1, "todo")).toBe("- [ ] task");
  });

  test("same type is a no-op", () => {
    expect(convert("- item", 1, 1, "bullet")).toBeNull();
    expect(convert("plain", 1, 1, "p")).toBeNull();
  });

  test("range with blank lines skips the blanks", () => {
    expect(convert("a\n\nb", 1, 3, "bullet")).toBe("- a\n\n- b");
  });

  test("numbered continues from the preceding same-level sibling", () => {
    expect(convert("1. a\n2. b\nc", 3, 3, "numbered")).toBe("1. a\n2. b\n3. c");
  });

  test("numbered range increments per line", () => {
    expect(convert("1. a\nb\nc", 2, 3, "numbered")).toBe("1. a\n2. b\n3. c");
  });

  test("numbered restarts at 1 after a run-breaking sibling", () => {
    expect(convert("1. a\nx\nc", 3, 3, "numbered")).toBe("1. a\nx\n1. c");
  });

  test("nested numbered continues the sibling run at its own indent", () => {
    const src = "- a\n  1. x\n  2. y\n  - z";
    expect(convert(src, 4, 4, "numbered")).toBe("- a\n  1. x\n  2. y\n  3. z");
  });

  test("nested numbered ignores deeper lines when scanning up", () => {
    const src = "1. a\n  - deep\nb";
    expect(convert(src, 3, 3, "numbered")).toBe("1. a\n  - deep\n2. b");
  });

  test("mixed-level range keeps a counter per level", () => {
    const src = "a\n  b\nc";
    expect(convert(src, 1, 3, "numbered")).toBe("1. a\n  1. b\n2. c");
  });

  test("range → code wraps once, prefixes stripped, single undoable set", () => {
    expect(convert("# t\nfoo", 1, 2, "code")).toBe("```\nt\nfoo\n```");
  });

  test("range → code keeps min indent on the fences", () => {
    expect(convert("  - a\n  - b", 1, 2, "code")).toBe("  ```\n  a\n  b\n  ```");
  });

  test("range → code lengthens the fence past inner backticks", () => {
    // A lone ``` line is an UNCLOSED fence → prose, so it converts as content.
    expect(convert("a\n```", 1, 2, "code")).toBe("````\na\n```\n````");
  });

  test("range → code merges an inner code void (fences dropped)", () => {
    const src = "a\n```\nx\n```\nb";
    expect(convert(src, 1, 5, "code")).toBe("```\na\nx\nb\n```");
  });

  test("code void → p unwraps fences and keeps content lines", () => {
    expect(convert("```js\nconst a = 1;\nconst b = 2;\n```", 1, 4, "p")).toBe("const a = 1;\nconst b = 2;");
    // Grip line anywhere inside the void converts the whole void.
    expect(convert("```\nx\n```", 2, 2, "p")).toBe("x");
  });

  test("empty code void → p leaves an empty line", () => {
    expect(convert("```\n```", 1, 2, "p")).toBe("");
  });

  test("code void → non-p is skipped", () => {
    expect(convert("```\nx\n```", 1, 3, "bullet")).toBeNull();
  });

  test("code → code is a no-op", () => {
    expect(convert("```\nx\n```", 1, 3, "code")).toBeNull();
  });

  test("table void is never converted", () => {
    const src = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(convert(src, 1, 3, "p")).toBeNull();
    expect(convert(src, 1, 3, "code")).toBeNull();
  });

  test("mixed range skips the table void but converts the rest", () => {
    const src = "x\n| a | b |\n| --- | --- |\n| 1 | 2 |\ny";
    expect(convert(src, 1, 5, "bullet")).toBe("- x\n| a | b |\n| --- | --- |\n| 1 | 2 |\n- y");
  });

  test("divider replaces a single line only", () => {
    expect(convert("foo", 1, 1, "divider")).toBe("---");
    expect(convert("a\nb", 1, 2, "divider")).toBeNull();
  });

  test("divider → bullet drops the dashes", () => {
    expect(convert("---", 1, 1, "bullet")).toBe("- ");
  });

  test("blank-only range is a no-op", () => {
    expect(convert("\n\n", 1, 3, "h1")).toBeNull();
  });

  test("indent is preserved when converting nested lines", () => {
    expect(convert("  - nested", 1, 1, "quote")).toBe("  > nested");
  });
});
