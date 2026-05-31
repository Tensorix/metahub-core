// Client-side block model for the document editor. This layer is intentionally
// richer than core's block splitter: the WebUI can model nested list items and
// code fence languages, then save the whole document back as canonical Markdown
// through the existing document body API.

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
  content: string; // inner text, without the markdown prefix/fence
  checked?: boolean; // todo only
  lang?: string; // code only
  children?: Block[]; // list items only
}

export type BlockDraft = Omit<Block, "id">;

let counter = 0;
export function genId(): string {
  return `blk_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}

const LIST_TYPES = new Set<BlockType>(["bullet", "numbered", "todo"]);

const RE = {
  fenceOpen: /^\s*(`{3,}|~{3,})\s*([^\s`]*)?.*$/,
  h: /^(#{1,3})\s+(.*)$/,
  todo: /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/,
  bullet: /^\s*[-*+]\s+(.*)$/,
  numbered: /^\s*\d+[.)]\s+(.*)$/,
  quote: /^>\s?(.*)$/,
  divider: /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/,
};

interface ListLine {
  indent: number;
  type: "bullet" | "numbered" | "todo";
  checked?: boolean;
  content: string;
}

interface Parsed {
  block: Block;
  next: number;
}

interface Shortcut {
  type: BlockType;
  content: string;
  checked?: boolean;
  lang?: string;
}

export function isListType(type: BlockType): boolean {
  return LIST_TYPES.has(type);
}

/** Parse one Markdown-ish block text into a typed editor block. */
export function textToBlock(text: string): BlockDraft {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const fence = firstLine.match(RE.fenceOpen);
  if (fence) {
    const lines = text.split("\n");
    if (RE.fenceOpen.test(lines[0]!)) lines.shift();
    if (lines.length && isFenceClose(lines[lines.length - 1]!, fence[1]![0]!, fence[1]!.length)) lines.pop();
    return { type: "code", content: lines.join("\n"), lang: cleanLang(fence[2] ?? "") };
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
      .map((l) => l.replace(/^\s*/, "").match(RE.quote)?.[1] ?? l)
      .join("\n");
    return { type: "quote", content };
  }
  return { type: "p", content: text };
}

/** Serialize one typed block back to canonical Markdown. */
export function blockToText(b: Block): string {
  return renderBlock(b, 0, 1).join("\n");
}

/** Body Markdown -> editor block tree. */
export function blocksFromBody(body: string | null | undefined): Block[] {
  const normalized = (body ?? "").replace(/\r\n?/g, "\n");
  const lines = normalized ? normalized.split("\n") : [];
  return parseContainer(lines, 0, 0).blocks;
}

/** Editor block tree -> body Markdown. Empty paragraphs are dropped. */
export function bodyFromBlocks(blocks: Block[]): string {
  return renderContainer(blocks, 0).join("\n").replace(/\n+$/, "");
}

export function shortcutFromInput(text: string, key: " " | "Enter"): Shortcut | null {
  if (key === " ") {
    if (text === "# ") return { type: "h1", content: "" };
    if (text === "## ") return { type: "h2", content: "" };
    if (text === "### ") return { type: "h3", content: "" };
    if (text === "> ") return { type: "quote", content: "" };
    if (/^[-*+] $/.test(text)) return { type: "bullet", content: "" };
    if (/^\d+[.)] $/.test(text)) return { type: "numbered", content: "" };

    const todo = text.match(/^[-*+]\s+\[([ xX])\]\s$/);
    if (todo) return { type: "todo", content: "", checked: todo[1]!.toLowerCase() === "x" };
    return null;
  }

  const code = text.match(/^```([A-Za-z0-9_+.#-]*)$/);
  if (code) return { type: "code", content: "", lang: cleanLang(code[1] ?? "") };
  return null;
}

function parseContainer(
  lines: string[],
  start: number,
  minIndent: number,
): { blocks: Block[]; next: number } {
  const blocks: Block[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (leadingIndent(line) < minIndent) break;

    const parsed = parseListItem(lines, i, minIndent) ?? parseLeafBlock(lines, i, minIndent);
    blocks.push(parsed.block);
    i = parsed.next;
  }

  return { blocks, next: i };
}

function parseListItem(lines: string[], start: number, minIndent: number): Parsed | null {
  const info = matchListLine(lines[start]!, minIndent);
  if (!info) return null;

  const block: Block = {
    id: genId(),
    type: info.type,
    content: info.content,
  };
  if (info.type === "todo") block.checked = !!info.checked;

  const child = parseContainer(lines, start + 1, info.indent + 2);
  if (child.blocks.length) block.children = child.blocks;
  return { block, next: child.next };
}

function parseLeafBlock(lines: string[], start: number, minIndent: number): Parsed {
  const first = stripIndent(lines[start]!, minIndent);
  const fence = first.match(RE.fenceOpen);
  if (fence) return parseCodeBlock(lines, start, minIndent, fence);

  if (RE.divider.test(first.trim())) {
    return { block: { id: genId(), type: "divider", content: "" }, next: start + 1 };
  }

  const heading = first.match(RE.h);
  if (heading) {
    return {
      block: {
        id: genId(),
        type: `h${heading[1]!.length}` as BlockType,
        content: heading[2]!,
      },
      next: start + 1,
    };
  }

  if (RE.quote.test(first)) return parseQuoteBlock(lines, start, minIndent);
  return parseParagraph(lines, start, minIndent);
}

function parseCodeBlock(
  lines: string[],
  start: number,
  minIndent: number,
  open: RegExpMatchArray,
): Parsed {
  const fence = open[1]!;
  const content: string[] = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    const stripped = stripIndent(raw, minIndent);
    if (isFenceClose(stripped, fence[0]!, fence.length)) {
      i++;
      break;
    }
    content.push(stripped);
  }
  return {
    block: { id: genId(), type: "code", content: content.join("\n"), lang: cleanLang(open[2] ?? "") },
    next: i,
  };
}

function parseQuoteBlock(lines: string[], start: number, minIndent: number): Parsed {
  const content: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "" || leadingIndent(raw) < minIndent) break;
    const quote = stripIndent(raw, minIndent).match(RE.quote);
    if (!quote) break;
    content.push(quote[1] ?? "");
  }
  return { block: { id: genId(), type: "quote", content: content.join("\n") }, next: i };
}

function parseParagraph(lines: string[], start: number, minIndent: number): Parsed {
  const content: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "" || leadingIndent(raw) < minIndent) break;
    if (content.length && startsLeafBlock(raw, minIndent)) break;
    content.push(stripIndent(raw, minIndent));
  }
  return { block: { id: genId(), type: "p", content: content.join("\n") }, next: i };
}

function startsLeafBlock(line: string, minIndent: number): boolean {
  if (matchListLine(line, minIndent)) return true;
  const text = stripIndent(line, minIndent);
  return !!text.match(RE.fenceOpen) || !!text.match(RE.h) || RE.divider.test(text.trim()) || RE.quote.test(text);
}

function matchListLine(line: string, minIndent: number): ListLine | null {
  const indent = leadingIndent(line);
  if (indent < minIndent) return null;
  const text = stripIndent(line, indent);

  let m = text.match(/^[-*+]\s+\[([ xX])\]\s*(.*)$/);
  if (m) {
    return {
      indent,
      type: "todo",
      checked: m[1]!.toLowerCase() === "x",
      content: m[2]!,
    };
  }

  m = text.match(/^\d+[.)]\s+(.*)$/);
  if (m) return { indent, type: "numbered", content: m[1]! };

  m = text.match(/^[-*+]\s+(.*)$/);
  if (m) return { indent, type: "bullet", content: m[1]! };

  return null;
}

function renderContainer(blocks: readonly Block[] | undefined, indent: number): string[] {
  const out: string[] = [];
  let prev: Block | null = null;
  let number = 1;

  for (const block of blocks ?? []) {
    if (!shouldPersist(block)) continue;
    if (out.length && shouldSeparate(prev, block)) out.push("");

    out.push(...renderBlock(block, indent, block.type === "numbered" ? number : 1));
    if (block.type === "numbered") number++;
    prev = block;
  }

  return out;
}

function renderBlock(block: Block, indent: number, number: number): string[] {
  const pad = " ".repeat(indent);
  switch (block.type) {
    case "h1":
      return [`${pad}# ${block.content}`];
    case "h2":
      return [`${pad}## ${block.content}`];
    case "h3":
      return [`${pad}### ${block.content}`];
    case "bullet":
    case "numbered":
    case "todo":
      return renderListBlock(block, indent, number);
    case "quote":
      return block.content.split("\n").map((line) => `${pad}>${line ? ` ${line}` : ""}`);
    case "code": {
      const first = `${pad}\`\`\`${block.lang ? cleanLang(block.lang) : ""}`;
      const body = block.content.split("\n").map((line) => `${pad}${line}`);
      return [first, ...body, `${pad}\`\`\``];
    }
    case "divider":
      return [`${pad}---`];
    default:
      return block.content.split("\n").map((line) => `${pad}${line}`);
  }
}

function renderListBlock(block: Block, indent: number, number: number): string[] {
  const pad = " ".repeat(indent);
  const marker =
    block.type === "numbered"
      ? `${number}. `
      : block.type === "todo"
        ? `- [${block.checked ? "x" : " "}] `
        : "- ";
  const lines = [`${pad}${marker}${block.content}`];
  const children = (block.children ?? []).filter(shouldPersist);
  if (children.length) {
    if (!isListType(children[0]!.type)) lines.push("");
    lines.push(...renderContainer(children, indent + 2));
  }
  return lines;
}

function shouldSeparate(prev: Block | null, next: Block): boolean {
  if (!prev) return false;
  return !(isListType(prev.type) && isListType(next.type));
}

function shouldPersist(block: Block): boolean {
  if (block.type === "divider") return true;
  if (isListType(block.type)) {
    return block.content.trim() !== "" || (block.children ?? []).some(shouldPersist);
  }
  if (block.type === "code") return block.content.trim() !== "" || !!block.lang?.trim();
  return block.content.trim() !== "";
}

function leadingIndent(line: string): number {
  let indent = 0;
  for (const ch of line) {
    if (ch === " ") indent++;
    else if (ch === "\t") indent += 4;
    else break;
  }
  return indent;
}

function stripIndent(line: string, columns: number): string {
  let indent = 0;
  let i = 0;
  for (; i < line.length && indent < columns; i++) {
    const ch = line[i]!;
    if (ch === " ") indent++;
    else if (ch === "\t") indent += 4;
    else break;
  }
  return line.slice(i);
}

function isFenceClose(line: string, char: string, len: number): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== char) return false;
  for (const ch of trimmed) {
    if (ch !== char) return false;
  }
  return trimmed.length >= len;
}

function cleanLang(lang: string): string {
  return lang.trim().replace(/[^A-Za-z0-9_+.#-]/g, "");
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
