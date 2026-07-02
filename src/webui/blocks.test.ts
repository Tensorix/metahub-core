import { test, expect } from "bun:test";
import { blocksFromBody, bodyFromBlocks, textToBlock, blockToText, shortcutFromInput, bulletTodoShortcut } from "./blocks.ts";

test("void embed blocks round-trip through Markdown", () => {
  // image with a resized width (?w=) — stored as src + width, re-emitted as ?w=
  const img = blocksFromBody("![shot](/blob/abc123abc123abc1.png?w=320)");
  expect(img).toMatchObject([{ type: "image", src: "/blob/abc123abc123abc1.png", name: "shot", width: 320 }]);
  expect(bodyFromBlocks(img)).toBe("![shot](/blob/abc123abc123abc1.png?w=320)");

  // video / audio: same image grammar, kind inferred from the extension
  expect(blocksFromBody("![clip](/blob/deadbeefdeadbeef.mp4)")[0]).toMatchObject({ type: "video" });
  expect(blocksFromBody("![tune](/blob/deadbeefdeadbeef.mp3)")[0]).toMatchObject({ type: "audio" });

  // file: a standalone /blob link (no `!`), byte size kept in the title
  const file = blocksFromBody('[report.zip](/blob/feedfacefeedface.zip "10240")');
  expect(file).toMatchObject([{ type: "file", src: "/blob/feedfacefeedface.zip", name: "report.zip", size: 10240 }]);
  expect(bodyFromBlocks(file)).toBe('[report.zip](/blob/feedfacefeedface.zip "10240")');

  // html: a reserved ```mh-html fence, body preserved verbatim
  const html = blocksFromBody("```mh-html\n<b>hi</b>\n<i>there</i>\n```");
  expect(html).toMatchObject([{ type: "html", content: "<b>hi</b>\n<i>there</i>" }]);
  expect(bodyFromBlocks(html)).toBe("```mh-html\n<b>hi</b>\n<i>there</i>\n```");
});

test("media promotion only fires when the block is solely the embed", () => {
  // an image followed by prose (same paragraph) stays an inline-image paragraph
  expect(blocksFromBody("see ![x](/blob/abcdef0123456789.png) here")[0]!.type).toBe("p");
  // a plain standalone hyperlink (not /blob) stays a paragraph, not a file card
  expect(blocksFromBody("[docs](https://example.com)")[0]!.type).toBe("p");
  // a bare image link with no width is a plain image block (no ?w=)
  expect(bodyFromBlocks(blocksFromBody("![](/blob/abcdef0123456789.png)"))).toBe(
    "![](/blob/abcdef0123456789.png)",
  );
});

test("textToBlock recognises each block type", () => {
  expect(textToBlock("# Title").type).toBe("h1");
  expect(textToBlock("## Title").type).toBe("h2");
  expect(textToBlock("### Title").type).toBe("h3");
  expect(textToBlock("#### Title").type).toBe("h4");
  expect(textToBlock("##### Title").type).toBe("h5");
  expect(textToBlock("###### Title").type).toBe("h6");
  // 7+ hashes is not a heading (CommonMark caps at 6)
  expect(textToBlock("####### Title").type).toBe("p");
  expect(textToBlock("- item")).toMatchObject({ type: "bullet", content: "item" });
  expect(textToBlock("1. item")).toMatchObject({ type: "numbered", content: "item" });
  expect(textToBlock("- [x] done")).toMatchObject({ type: "todo", content: "done", checked: true });
  expect(textToBlock("- [ ] todo")).toMatchObject({ type: "todo", content: "todo", checked: false });
  expect(textToBlock("> quote")).toMatchObject({ type: "quote", content: "quote" });
  expect(textToBlock("---").type).toBe("divider");
  expect(textToBlock("hello world")).toMatchObject({ type: "p", content: "hello world" });
});

test("code blocks keep their inner text whole", () => {
  const b = textToBlock("```ts\nconst x = 1\n\nconst y = 2\n```");
  expect(b.type).toBe("code");
  expect(b.lang).toBe("ts");
  expect(b.content).toBe("const x = 1\n\nconst y = 2");
  expect(blockToText({ id: "1", ...b })).toBe("```ts\nconst x = 1\n\nconst y = 2\n```");
});

test("blocksFromBody splits a tight list into one block per item", () => {
  const blocks = blocksFromBody("- a\n- b\n- c");
  expect(blocks.map((b) => b.type)).toEqual(["bullet", "bullet", "bullet"]);
  expect(blocks.map((b) => b.content)).toEqual(["a", "b", "c"]);
});

test("body round-trips through blocks and stays stable on re-parse", () => {
  const body = "# Heading\n\nA paragraph.\n\n- one\n- two\n\n> a quote\n\n```\ncode()\n```";
  const blocks = blocksFromBody(body);
  expect(blocks.map((b) => b.type)).toEqual([
    "h1",
    "p",
    "bullet",
    "bullet",
    "quote",
    "code",
  ]);
  const out = bodyFromBlocks(blocks);
  // re-parsing the serialized body yields the same block sequence (idempotent)
  expect(blocksFromBody(out).map((b) => [b.type, b.content])).toEqual(
    blocks.map((b) => [b.type, b.content]),
  );
});

test("interior empty paragraphs persist as blank lines on serialize", () => {
  const blocks = [
    { id: "1", type: "p" as const, content: "keep" },
    { id: "2", type: "p" as const, content: "   " }, // user spacing -> extra blank line
    { id: "3", type: "divider" as const, content: "" },
  ];
  expect(bodyFromBlocks(blocks)).toBe("keep\n\n\n---");
});

test("trailing blank lines round-trip as empty paragraphs", () => {
  // one blank line at the end -> one empty paragraph that survives serialize
  const blocks = blocksFromBody("keep\n\n");
  expect(blocks.map((b) => [b.type, b.content])).toEqual([["p", "keep"], ["p", ""]]);
  expect(bodyFromBlocks(blocks)).toBe("keep\n\n");

  // two blank lines -> two empty paragraphs
  expect(blocksFromBody("keep\n\n\n").map((b) => b.type)).toEqual(["p", "p", "p"]);
  expect(bodyFromBlocks(blocksFromBody("keep\n\n\n"))).toBe("keep\n\n\n");
});

test("a single trailing newline is not a blank line", () => {
  const blocks = blocksFromBody("keep\n");
  expect(blocks.map((b) => [b.type, b.content])).toEqual([["p", "keep"]]);
  expect(bodyFromBlocks(blocks)).toBe("keep");
});

test("interior and trailing empty paragraphs both survive serialize", () => {
  const blocks = [
    { id: "1", type: "p" as const, content: "keep" },
    { id: "2", type: "p" as const, content: "   " },
    { id: "3", type: "p" as const, content: "tail" },
    { id: "4", type: "p" as const, content: "" },
  ];
  expect(bodyFromBlocks(blocks)).toBe("keep\n\n\ntail\n\n");
});

test("interior blank runs round-trip as empty paragraphs", () => {
  // one extra blank line between two paragraphs -> one interior empty paragraph
  const blocks = blocksFromBody("a\n\n\nb");
  expect(blocks.map((b) => [b.type, b.content])).toEqual([["p", "a"], ["p", ""], ["p", "b"]]);
  expect(bodyFromBlocks(blocks)).toBe("a\n\n\nb");

  // interior + trailing together stay stable
  const body = "a\n\n\nb\n\n";
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body);
});

test("blank lines between list items round-trip (tight list stays tight)", () => {
  // no blank between items -> tight list, no empty paragraph
  expect(bodyFromBlocks(blocksFromBody("- a\n- b"))).toBe("- a\n- b");

  // an empty paragraph between two bullets survives as one extra blank line
  const blocks = [
    { id: "1", type: "bullet" as const, content: "a" },
    { id: "2", type: "p" as const, content: "" },
    { id: "3", type: "bullet" as const, content: "b" },
  ];
  const body = bodyFromBlocks(blocks);
  expect(body).toBe("- a\n\n\n- b");
  expect(blocksFromBody(body).map((b) => [b.type, b.content])).toEqual([
    ["bullet", "a"],
    ["p", ""],
    ["bullet", "b"],
  ]);
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body); // idempotent
});

test("an empty list item keeps its type across a round-trip (not a blank line)", () => {
  // leaving a list item empty = a blank *list item*; its marker is serialized so
  // it reloads as the same list type, not a plain gap.
  const blocks = [
    { id: "1", type: "bullet" as const, content: "a" },
    { id: "2", type: "bullet" as const, content: "" }, // empty bullet keeps its marker
    { id: "3", type: "bullet" as const, content: "b" },
  ];
  const body = bodyFromBlocks(blocks);
  expect(body).toBe("- a\n- \n- b");
  expect(blocksFromBody(body).map((b) => [b.type, b.content])).toEqual([
    ["bullet", "a"],
    ["bullet", ""],
    ["bullet", "b"],
  ]);
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body); // idempotent
});

test("an empty ordered item keeps the list ordered across a round-trip", () => {
  // 1. foo / (empty) / 3. bar — the empty middle stays an ordered item ("2. ")
  const body = "1. foo\n2. \n3. bar";
  expect(blocksFromBody(body).map((b) => [b.type, b.content])).toEqual([
    ["numbered", "foo"],
    ["numbered", ""],
    ["numbered", "bar"],
  ]);
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body);
});

test("deleting an item's marker leaves a plain paragraph gap", () => {
  // user removed the "2." marker -> the middle is a plain (empty) paragraph; it
  // round-trips as a blank line, staying a paragraph, not an ordered item.
  const blocks = [
    { id: "1", type: "numbered" as const, content: "foo" },
    { id: "2", type: "p" as const, content: "" }, // marker deleted -> plain gap
    { id: "3", type: "numbered" as const, content: "bar" },
  ];
  const body = bodyFromBlocks(blocks);
  expect(body).toBe("1. foo\n\n\n2. bar");
  expect(blocksFromBody(body).map((b) => [b.type, b.content])).toEqual([
    ["numbered", "foo"],
    ["p", ""],
    ["numbered", "bar"],
  ]);
});

test("a bare marker (no trailing space) is a paragraph, not a list item", () => {
  // STRICT grammar: `-` / `1.` without the trailing space is the mid-typing
  // state, a paragraph on every surface (editor render, save parser, share
  // page). The serializer's empty-item form `- ` (marker + trailing space)
  // still round-trips as an empty item.
  expect(blocksFromBody("- a\n-\n- b").map((b) => [b.type, b.content])).toEqual([
    ["bullet", "a"],
    ["p", "-"],
    ["bullet", "b"],
  ]);
  expect(blocksFromBody("1.\n2. x").map((b) => b.type)).toEqual(["p", "numbered"]);
  // `- ` with its trailing space is an empty item and round-trips losslessly
  expect(blocksFromBody("- a\n- \n- b").map((b) => [b.type, b.content])).toEqual([
    ["bullet", "a"],
    ["bullet", ""],
    ["bullet", "b"],
  ]);
  expect(bodyFromBlocks(blocksFromBody("- a\n- \n- b"))).toBe("- a\n- \n- b");
  // `---` is still a divider, `-foo` still a paragraph
  expect(blocksFromBody("---")[0]!.type).toBe("divider");
  expect(blocksFromBody("-foo")[0]!.type).toBe("p");
});

test("quote requires a space after '>' (bare '>' is a mid-typing paragraph)", () => {
  // `>foo` and a bare `>` are paragraphs on every surface; `> foo` and the
  // serializer's `> ` (empty quote line, marker + trailing space) are quotes.
  // Parse-only change: bodies with `>foo`/`>` are never rewritten, they just
  // render consistently as paragraphs now.
  expect(textToBlock(">foo")).toMatchObject({ type: "p", content: ">foo" });
  expect(blocksFromBody(">foo")[0]).toMatchObject({ type: "p", content: ">foo" });
  expect(blocksFromBody(">")[0]).toMatchObject({ type: "p", content: ">" });
  expect(blocksFromBody("> ")[0]).toMatchObject({ type: "quote", content: "" });
  // an interior empty quote line round-trips through the `> ` form
  const body = "> a\n> \n> b";
  expect(blocksFromBody(body)).toMatchObject([{ type: "quote", content: "a\n\nb" }]);
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body);
});

test("todo requires whitespace after ']' (bare '- [ ]' stays a bullet)", () => {
  expect(textToBlock("- [ ]")).toMatchObject({ type: "bullet", content: "[ ]" });
  expect(blocksFromBody("- [ ]")[0]).toMatchObject({ type: "bullet", content: "[ ]" });
  expect(blocksFromBody("- [ ] ")[0]).toMatchObject({ type: "todo", content: "", checked: false });
  expect(blocksFromBody("- [x] done")[0]).toMatchObject({ type: "todo", content: "done", checked: true });
  // an empty todo round-trips through the `- [ ] ` form
  expect(bodyFromBlocks(blocksFromBody("- [ ] "))).toBe("- [ ] ");
});

test("empty list items survive at any nesting depth", () => {
  const body = "- a\n  - x\n  - \n  - y\n- b";
  const blocks = blocksFromBody(body);
  expect(blocks[0]!.children?.map((b) => [b.type, b.content])).toEqual([
    ["bullet", "x"],
    ["bullet", ""],
    ["bullet", "y"],
  ]);
  expect(bodyFromBlocks(blocks)).toBe(body);
});

test("blank-line gaps survive between nested list items", () => {
  const body = "- a\n  - b\n\n\n  - c";
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body);
});

test("blank-line gaps survive inside nested list content", () => {
  // an extra blank line between two child paragraphs of a list item is kept
  const body = "- a\n\n  child1\n\n\n  child2";
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body);
});

test("a blank line between numbered items keeps the run going (1, 2)", () => {
  const blocks = [
    { id: "1", type: "numbered" as const, content: "a" },
    { id: "2", type: "p" as const, content: "" },
    { id: "3", type: "numbered" as const, content: "b" },
  ];
  expect(bodyFromBlocks(blocks)).toBe("1. a\n\n\n2. b");
  expect(bodyFromBlocks(blocksFromBody("1. a\n\n\n2. b"))).toBe("1. a\n\n\n2. b");
});

test("nested ordered lists keep child paragraphs, quotes, and fenced code", () => {
  const body = [
    "4. Parent",
    "  9. Child",
    "",
    "    Child paragraph",
    "",
    "    > child quote",
    "",
    "    ```python",
    "    print('hi')",
    "    ```",
    "2. Sibling",
  ].join("\n");

  const blocks = blocksFromBody(body);
  expect(blocks).toHaveLength(2);
  expect(blocks[0]).toMatchObject({ type: "numbered", content: "Parent" });
  expect(blocks[0]!.children?.[0]).toMatchObject({ type: "numbered", content: "Child" });
  expect(blocks[0]!.children?.[0]?.children?.map((b) => [b.type, b.content, b.lang ?? ""])).toEqual([
    ["p", "Child paragraph", ""],
    ["quote", "child quote", ""],
    ["code", "print('hi')", "python"],
  ]);

  expect(bodyFromBlocks(blocks)).toBe([
    "4. Parent",
    "  9. Child",
    "",
    "    Child paragraph",
    "",
    "    > child quote",
    "",
    "    ```python",
    "    print('hi')",
    "    ```",
    "5. Sibling",
  ].join("\n"));
});

test("ordered runs start at the first item's number, then auto-increment", () => {
  // The first item's number is honoured; later items re-sequence from it.
  const blocks = blocksFromBody("3. top\n  9. nested\n  3. nested again\n8. next");
  expect(bodyFromBlocks(blocks)).toBe("3. top\n  9. nested\n  10. nested again\n4. next");
});

test("ordered start is preserved across a Markdown round-trip", () => {
  const body = "5. a\n6. b\n7. c";
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body);
});

test("repeated '1.' input re-sequences to 1, 2, 3", () => {
  const blocks = blocksFromBody("1. a\n1. b\n1. c");
  expect(bodyFromBlocks(blocks)).toBe("1. a\n2. b\n3. c");
  // start defaults away when it is 1
  expect(blocks[0]!.start).toBeUndefined();
});

test("only the first item of a run keeps an explicit start", () => {
  const blocks = blocksFromBody("5. a\n6. b");
  expect(blocks[0]!.start).toBe(5);
  expect(blocks[1]!.start).toBeUndefined();
});

test("deleting the first item re-sequences the run from the new head", () => {
  const blocks = blocksFromBody("5. a\n6. b\n7. c");
  blocks.shift(); // remove "5. a"
  expect(bodyFromBlocks(blocks)).toBe("1. b\n2. c");
});

test("nested list serialization reflects indent and outdent moves", () => {
  const blocks = blocksFromBody("- one\n- child\n- two");
  const child = blocks.splice(1, 1)[0]!;
  blocks[0]!.children = [child];
  expect(bodyFromBlocks(blocks)).toBe("- one\n  - child\n- two");

  blocks.splice(1, 0, blocks[0]!.children!.shift()!);
  delete blocks[0]!.children;
  expect(bodyFromBlocks(blocks)).toBe("- one\n- child\n- two");
});

test("list items can own fenced code children", () => {
  const body = bodyFromBlocks([
    {
      id: "1",
      type: "bullet",
      content: "",
      children: [{ id: "2", type: "code", content: "print(1)", lang: "python" }],
    },
  ]);

  expect(body).toBe("- \n  ```python\n  print(1)\n  ```");

  const parsed = blocksFromBody(body);
  expect(parsed[0]).toMatchObject({ type: "bullet", content: "" });
  expect(parsed[0]!.children?.[0]).toMatchObject({ type: "code", content: "print(1)", lang: "python" });
});

test("GFM table parses into header + body rows with alignment", () => {
  const body = ["| Name | Age |", "| :--- | ---: |", "| Ann | 30 |", "| Bob | 7 |"].join("\n");
  const blocks = blocksFromBody(body);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({
    type: "table",
    rows: [["Name", "Age"], ["Ann", "30"], ["Bob", "7"]],
    align: ["left", "right"],
  });
});

test("table round-trips through Markdown and stays stable", () => {
  const body = ["| A | B | C |", "| :--- | :---: | ---: |", "| 1 | 2 | 3 |"].join("\n");
  expect(bodyFromBlocks(blocksFromBody(body))).toBe(body);
});

test("table cells escape pipes and pad short rows", () => {
  const blocks = blocksFromBody(["| a | b |", "| --- | --- |", "| x |"].join("\n"));
  // short body row is padded to the header column count
  expect(blocks[0]!.rows).toEqual([["a", "b"], ["x", ""]]);

  const out = bodyFromBlocks([
    { id: "1", type: "table", content: "", rows: [["a|b", "c"], ["d", "e"]], align: [null, null] },
  ]);
  expect(out).toBe(["| a\\|b | c |", "| --- | --- |", "| d | e |"].join("\n"));
  // escaped pipe survives the round-trip back into a single cell
  expect(blocksFromBody(out)[0]!.rows).toEqual([["a|b", "c"], ["d", "e"]]);
});

test("an empty table is dropped on serialize", () => {
  expect(bodyFromBlocks([{ id: "1", type: "table", content: "", rows: [["", ""], ["", ""]], align: [null, null] }])).toBe("");
});

test("a paragraph before a table is not merged into it", () => {
  const blocks = blocksFromBody(["intro", "| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"));
  expect(blocks.map((b) => b.type)).toEqual(["p", "table"]);
});

test("typing shortcuts recognise markdown prefixes", () => {
  expect(shortcutFromInput("1. ", " ")).toMatchObject({ type: "numbered", content: "", start: 1 });
  expect(shortcutFromInput("5. ", " ")).toMatchObject({ type: "numbered", content: "", start: 5 });
  expect(shortcutFromInput("> ", " ")).toMatchObject({ type: "quote", content: "" });
  expect(shortcutFromInput("- [ ] ", " ")).toMatchObject({ type: "todo", checked: false });
  expect(shortcutFromInput("- [x] ", " ")).toMatchObject({ type: "todo", checked: true });
  expect(shortcutFromInput("## ", " ")).toMatchObject({ type: "h2", content: "" });
  expect(shortcutFromInput("#### ", " ")).toMatchObject({ type: "h4", content: "" });
  expect(shortcutFromInput("###### ", " ")).toMatchObject({ type: "h6", content: "" });
  expect(shortcutFromInput("####### ", " ")).toBeNull(); // 7 hashes is not a heading
  expect(shortcutFromInput("```python", "Enter")).toMatchObject({ type: "code", lang: "python" });
});

test("h4-h6 headings round-trip through Markdown losslessly", () => {
  const md = "#### four\n\n##### five\n\n###### six";
  const blocks = blocksFromBody(md);
  expect(blocks.map((b) => b.type)).toEqual(["h4", "h5", "h6"]);
  expect(bodyFromBlocks(blocks)).toBe(md);
});

test("a bullet promotes to a todo when its '[ ]'/'[x]' prefix completes", () => {
  expect(bulletTodoShortcut("[ ]")).toEqual({ checked: false });
  expect(bulletTodoShortcut("[x]")).toEqual({ checked: true });
  expect(bulletTodoShortcut("[X]")).toEqual({ checked: true });
  expect(bulletTodoShortcut("[ ]x")).toBeNull();
  expect(bulletTodoShortcut("abc")).toBeNull();
  expect(bulletTodoShortcut("")).toBeNull();
});

test("an unclosed fence is prose, not a code block that swallows the rest", () => {
  // Pasted sentence that happens to start with ``` — with and without a space.
  expect(blocksFromBody("``` 代码块 连续两次回车，脱出 代码编辑区域")).toMatchObject([
    { type: "p", content: "``` 代码块 连续两次回车，脱出 代码编辑区域" },
  ]);
  expect(blocksFromBody("```代码块直接跟内容")).toMatchObject([{ type: "p", content: "```代码块直接跟内容" }]);
  expect(blocksFromBody("```foo```")).toMatchObject([{ type: "p", content: "```foo```" }]);
  // Following lines keep their own block types instead of being swallowed.
  expect(blocksFromBody("``` 首行\n普通段落\n- [ ] 列表项").map((b) => b.type)).toEqual(["p", "todo"]);
});

test("a closed fence still parses as a code block", () => {
  expect(blocksFromBody("```ts\nconst x = 1\n```")).toMatchObject([
    { type: "code", content: "const x = 1", lang: "ts" },
  ]);
});

test("a paragraph containing a fence-like line round-trips without eating the document", () => {
  const blocks: ReturnType<typeof blocksFromBody> = [
    { id: "1", type: "p", content: "``` 看起来像围栏的段落" },
    { id: "2", type: "p", content: "后面的段落" },
    { id: "3", type: "code", content: "real()", lang: "js" },
  ];
  const body = bodyFromBlocks(blocks);
  expect(body).toContain("\\``` 看起来像围栏的段落"); // serialized behind a backslash
  expect(blocksFromBody(body).map((b) => [b.type, b.content])).toEqual(
    blocks.map((b) => [b.type, b.content]),
  );
});

test("literal backslash-fence text escapes the escape and round-trips", () => {
  const blocks: ReturnType<typeof blocksFromBody> = [{ id: "1", type: "p", content: "\\``` 字面反斜杠" }];
  const body = bodyFromBlocks(blocks);
  expect(body).toBe("\\\\``` 字面反斜杠");
  expect(blocksFromBody(body)).toMatchObject([{ type: "p", content: "\\``` 字面反斜杠" }]);
});
