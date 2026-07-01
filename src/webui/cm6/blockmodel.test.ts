import { test, expect } from "bun:test";
import { scanDoc, voidAt, insideVoid, type DocModel } from "./blockmodel";

/** Assert every line's offsets are self-consistent and match the source slice. */
function checkOffsets(src: string, model: DocModel) {
  const froms: number[] = [];
  let off = 0;
  for (const l of src.split("\n")) {
    froms.push(off);
    off += l.length + 1;
  }
  expect(model.lines.length).toBe(src.split("\n").length);
  model.lines.forEach((li, i) => {
    expect(li.number).toBe(i + 1);
    expect(li.from).toBe(froms[i]!);
    expect(li.to).toBe(froms[i]! + li.text.length);
    expect(src.slice(li.from, li.to)).toBe(li.text);
    expect(li.contentFrom).toBeGreaterThanOrEqual(li.from);
    expect(li.contentFrom).toBeLessThanOrEqual(li.to);
  });
}

test("plain paragraph", () => {
  const src = "hello world";
  const m = scanDoc(src);
  checkOffsets(src, m);
  expect(m.lines[0]!.role).toBe("p");
  expect(m.lines[0]!.contentFrom).toBe(0);
  expect(m.voids).toEqual([]);
});

test("headings h1-h6 with content offset", () => {
  const src = "# One\n## Two\n###### Six";
  const m = scanDoc(src);
  checkOffsets(src, m);
  expect(m.lines.map((l) => l.role)).toEqual(["h1", "h2", "h6"]);
  // contentFrom points past "# "
  expect(src.slice(m.lines[0]!.contentFrom, m.lines[0]!.to)).toBe("One");
  expect(src.slice(m.lines[2]!.contentFrom, m.lines[2]!.to)).toBe("Six");
});

test("bullet / numbered / todo markers and content offsets", () => {
  const src = "- apple\n1. first\n- [x] done\n- [ ] todo";
  const m = scanDoc(src);
  checkOffsets(src, m);
  expect(m.lines.map((l) => l.role)).toEqual(["bullet", "numbered", "todo", "todo"]);
  expect(src.slice(m.lines[0]!.contentFrom, m.lines[0]!.to)).toBe("apple");
  expect(m.lines[1]!.num).toBe(1);
  expect(src.slice(m.lines[1]!.contentFrom, m.lines[1]!.to)).toBe("first");
  expect(m.lines[2]!.checked).toBe(true);
  expect(src.slice(m.lines[2]!.contentFrom, m.lines[2]!.to)).toBe("done");
  expect(m.lines[3]!.checked).toBe(false);
  expect(src.slice(m.lines[3]!.contentFrom, m.lines[3]!.to)).toBe("todo");
});

test("numbered literal number is preserved (not renumbered)", () => {
  const src = "5. five\n6. six";
  const m = scanDoc(src);
  expect(m.lines[0]!.num).toBe(5);
  expect(m.lines[1]!.num).toBe(6);
});

test("bare list markers round-trip (empty item)", () => {
  const src = "- \n1. ";
  const m = scanDoc(src);
  checkOffsets(src, m);
  expect(m.lines[0]!.role).toBe("bullet");
  expect(m.lines[1]!.role).toBe("numbered");
  // content is empty; contentFrom sits at line end
  expect(m.lines[0]!.contentFrom).toBe(m.lines[0]!.to);
});

test("nested list indent → level + indentChars", () => {
  const src = "- top\n  - child\n    - grand";
  const m = scanDoc(src);
  checkOffsets(src, m);
  expect(m.lines.map((l) => l.level)).toEqual([0, 1, 2]);
  expect(m.lines.map((l) => l.indentChars)).toEqual([0, 2, 4]);
  expect(m.lines.map((l) => l.role)).toEqual(["bullet", "bullet", "bullet"]);
  // marker begins after the leading whitespace
  expect(m.lines[1]!.markerFrom).toBe(m.lines[1]!.from + 2);
  expect(src.slice(m.lines[2]!.contentFrom, m.lines[2]!.to)).toBe("grand");
});

test("quote and divider and blank", () => {
  const src = "> quoted\n\n---";
  const m = scanDoc(src);
  checkOffsets(src, m);
  expect(m.lines.map((l) => l.role)).toEqual(["quote", "blank", "divider"]);
  expect(src.slice(m.lines[0]!.contentFrom, m.lines[0]!.to)).toBe("quoted");
});

test("fenced code block is one void with parsed block", () => {
  const src = "before\n```ts\nconst x = 1\n```\nafter";
  const m = scanDoc(src);
  checkOffsets(src, m);
  expect(m.voids.length).toBe(1);
  const v = m.voids[0]!;
  expect(v.kind).toBe("code");
  expect(v.block.type).toBe("code");
  expect(v.block.lang).toBe("ts");
  expect(v.block.content).toBe("const x = 1");
  expect(v.fromLine).toBe(2);
  expect(v.toLine).toBe(4);
  // the three fence lines are role "void"; the prose lines are not
  expect(m.lines.map((l) => l.role)).toEqual(["p", "void", "void", "void", "p"]);
  // void source slice matches the fence exactly
  expect(src.slice(v.from, v.to)).toBe("```ts\nconst x = 1\n```");
});

test("mh-html fence → html void", () => {
  const src = "```mh-html\n<b>hi</b>\n```";
  const m = scanDoc(src);
  expect(m.voids.length).toBe(1);
  expect(m.voids[0]!.kind).toBe("html");
  expect(m.voids[0]!.block.type).toBe("html");
  expect(m.voids[0]!.block.content).toBe("<b>hi</b>");
});

test("UNCLOSED fence is prose, not a void (no swallow)", () => {
  const src = "```ts\nconst x = 1\nstill typing";
  const m = scanDoc(src);
  checkOffsets(src, m);
  expect(m.voids).toEqual([]);
  expect(m.lines.every((l) => l.role === "p")).toBe(true);
});

test("empty closed fence is a void (slash-inserted code)", () => {
  const src = "```\n\n```";
  const m = scanDoc(src);
  expect(m.voids.length).toBe(1);
  expect(m.voids[0]!.kind).toBe("code");
  expect(m.lines.map((l) => l.role)).toEqual(["void", "void", "void"]);
});

test("GFM table is one void with rows/align", () => {
  const src = "| A | B |\n| :--- | ---: |\n| 1 | 2 |\n| 3 | 4 |";
  const m = scanDoc(src);
  checkOffsets(src, m);
  expect(m.voids.length).toBe(1);
  const v = m.voids[0]!;
  expect(v.kind).toBe("table");
  expect(v.block.type).toBe("table");
  expect(v.block.rows).toEqual([
    ["A", "B"],
    ["1", "2"],
    ["3", "4"],
  ]);
  expect(v.block.align).toEqual(["left", "right"]);
  expect(v.fromLine).toBe(1);
  expect(v.toLine).toBe(4);
  expect(m.lines.every((l) => l.role === "void")).toBe(true);
});

test("single-line media embeds are voids", () => {
  const src = "![alt](/blob/abc.png?w=300)\n[doc.pdf](/blob/def.pdf \"1024\")\ntext";
  const m = scanDoc(src);
  checkOffsets(src, m);
  expect(m.voids.length).toBe(2);
  expect(m.voids[0]!.kind).toBe("image");
  expect(m.voids[0]!.block.width).toBe(300);
  expect(m.voids[1]!.kind).toBe("file");
  expect(m.voids[1]!.block.size).toBe(1024);
  expect(m.lines.map((l) => l.role)).toEqual(["void", "void", "p"]);
});

test("voidAt / insideVoid endpoints inclusive", () => {
  const src = "```\ncode\n```";
  const m = scanDoc(src);
  const v = m.voids[0]!;
  expect(voidAt(m, v.from)).toBe(v);
  expect(voidAt(m, v.to)).toBe(v);
  expect(insideVoid(m, v.from + 1)).toBe(true);
  // one past the end is the newline into the next block → not inside
  expect(voidAt(m, v.to + 1)).toBeNull();
});

test("mixed document: offsets stay consistent throughout", () => {
  const src = [
    "# Title",
    "",
    "Some *para* text",
    "",
    "- one",
    "- two",
    "",
    "```js",
    "x()",
    "```",
    "",
    "> quote",
  ].join("\n");
  const m = scanDoc(src);
  checkOffsets(src, m);
  expect(m.voids.length).toBe(1);
  expect(m.voids[0]!.kind).toBe("code");
});

test("empty document", () => {
  const m = scanDoc("");
  expect(m.lines.length).toBe(1);
  expect(m.lines[0]!.role).toBe("blank");
  expect(m.voids).toEqual([]);
});

test("numbered lines keep their literal number + track digit width", () => {
  // Numbers are literal source (no auto display-renumber); numChars drives the
  // Tab-time digit rewrite, so it tracks the actual digit run.
  const m = scanDoc("9. a\n10. b\n  2. c");
  expect(m.lines.map((l) => l.num)).toEqual([9, 10, 2]);
  expect(m.lines[0]!.numChars).toBe(1);
  expect(m.lines[1]!.numChars).toBe(2);
});
