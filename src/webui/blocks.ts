// Client-side block model for the document editor. Each editor block maps to
// exactly one core block (doc_blocks row): we round-trip the document body
// through core's parseBlocks (blank-line separated; fenced code kept whole) so
// that saving `bodyFromBlocks(...)` reconciles per-block and preserves CRDT
// identity. List items are serialized as separate blocks (blank line between)
// so each item is its own block — the Notion-style one-line-one-block model.

import { parseBlocks } from "../core/blocks.ts";

export type BlockType =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "numbered"
  | "todo"
  | "quote"
  | "code"
  | "divider";

export interface Block {
  id: string;
  type: BlockType;
  content: string; // inner text, without the markdown prefix
  checked?: boolean; // todo only
}

let counter = 0;
export function genId(): string {
  return `blk_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}

const RE = {
  fence: /^\s*(```|~~~)/,
  h: /^(#{1,3})\s+(.*)$/,
  todo: /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/,
  bullet: /^\s*[-*]\s+(.*)$/,
  numbered: /^\s*\d+\.\s+(.*)$/,
  quote: /^\s*>\s?(.*)$/,
  divider: /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/,
};

function isListLine(line: string): boolean {
  return RE.todo.test(line) || RE.bullet.test(line) || RE.numbered.test(line);
}

/** Parse one core-block text (single item or paragraph) into a typed block. */
export function textToBlock(text: string): Omit<Block, "id"> {
  const firstLine = text.split("\n", 1)[0] ?? "";
  if (RE.fence.test(firstLine)) {
    const lines = text.split("\n");
    if (RE.fence.test(lines[0]!)) lines.shift();
    if (lines.length && RE.fence.test(lines[lines.length - 1]!)) lines.pop();
    return { type: "code", content: lines.join("\n") };
  }
  if (RE.divider.test(text.trim()) && !text.includes("\n")) return { type: "divider", content: "" };

  let m: RegExpMatchArray | null;
  if ((m = firstLine.match(RE.h))) {
    const level = m[1]!.length as 1 | 2 | 3;
    return { type: (`h${level}` as BlockType), content: m[2]! };
  }
  if ((m = firstLine.match(RE.todo)))
    return { type: "todo", content: m[2]!, checked: m[1]!.toLowerCase() === "x" };
  if ((m = firstLine.match(RE.numbered))) return { type: "numbered", content: m[1]! };
  if ((m = firstLine.match(RE.bullet))) return { type: "bullet", content: m[1]! };
  if (RE.quote.test(firstLine)) {
    const content = text
      .split("\n")
      .map((l) => l.match(RE.quote)?.[1] ?? l)
      .join("\n");
    return { type: "quote", content };
  }
  return { type: "p", content: text };
}

/** Serialize one typed block back to its markdown text. */
export function blockToText(b: Block): string {
  switch (b.type) {
    case "h1":
      return `# ${b.content}`;
    case "h2":
      return `## ${b.content}`;
    case "h3":
      return `### ${b.content}`;
    case "bullet":
      return `- ${b.content}`;
    case "numbered":
      return `1. ${b.content}`;
    case "todo":
      return `- [${b.checked ? "x" : " "}] ${b.content}`;
    case "quote":
      return b.content
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "code":
      return "```\n" + b.content + "\n```";
    case "divider":
      return "---";
    default:
      return b.content;
  }
}

/** Body markdown → editor blocks. Multi-line list blocks are split per item. */
export function blocksFromBody(body: string | null | undefined): Block[] {
  const blocks: Block[] = [];
  for (const text of parseBlocks(body ?? "")) {
    const firstLine = text.split("\n", 1)[0] ?? "";
    const lines = text.split("\n");
    if (!RE.fence.test(firstLine) && lines.length > 1 && lines.every(isListLine)) {
      for (const line of lines) blocks.push({ id: genId(), ...textToBlock(line) });
    } else {
      blocks.push({ id: genId(), ...textToBlock(text) });
    }
  }
  return blocks;
}

/** Editor blocks → body markdown. Empty paragraphs are dropped (not persisted). */
export function bodyFromBlocks(blocks: Block[]): string {
  return blocks
    .filter((b) => b.type === "divider" || b.content.trim() !== "")
    .map(blockToText)
    .join("\n\n");
}

export const BLOCK_MENU: { type: BlockType; ic: string; t: string; d: string }[] = [
  { type: "p", ic: "text", t: "文本", d: "普通段落" },
  { type: "h1", ic: "heading", t: "标题 1", d: "大号标题" },
  { type: "h2", ic: "heading", t: "标题 2", d: "中号标题" },
  { type: "h3", ic: "heading", t: "标题 3", d: "小号标题" },
  { type: "bullet", ic: "list", t: "无序列表", d: "项目符号" },
  { type: "numbered", ic: "numList", t: "有序列表", d: "编号列表" },
  { type: "todo", ic: "checkbox", t: "待办清单", d: "复选项" },
  { type: "quote", ic: "quote", t: "引用", d: "引用块" },
  { type: "code", ic: "code", t: "代码", d: "代码块" },
  { type: "divider", ic: "minus", t: "分隔线", d: "水平分隔" },
];
