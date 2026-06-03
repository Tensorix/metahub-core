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
  | "table"
  | "divider";

export type ColAlign = "left" | "center" | "right" | null;

export interface Block {
  id: string;
  type: BlockType;
  content: string; // inner text, without the markdown prefix/fence
  checked?: boolean; // todo only
  lang?: string; // code only
  start?: number; // numbered only: explicit start number of a run (first item)
  children?: Block[]; // list items only
  rows?: string[][]; // table only: rows[0] is the header; each cell is inline markdown
  align?: ColAlign[]; // table only: per-column text alignment
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
  numbered: /^\s*(\d+)[.)]\s+(.*)$/,
  quote: /^>\s?(.*)$/,
  divider: /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/,
};

interface ListLine {
  indent: number;
  type: "bullet" | "numbered" | "todo";
  checked?: boolean;
  content: string;
  num?: number; // numbered only: the literal number the user wrote
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
  start?: number;
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
  if ((m = firstLine.match(RE.numbered))) return { type: "numbered", content: m[2]!, start: parseInt(m[1]!, 10) };
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
  const blocks = parseContainer(lines, 0, 0).blocks;
  normalizeNumbering(blocks);
  // Blank lines the user left at the very end (for spacing) become empty
  // paragraphs so the gap survives a save/reload. One trailing newline is the
  // conventional file terminator and is ignored; every newline beyond it is a
  // real blank line.
  const trailingNewlines = normalized.length - normalized.replace(/\n+$/, "").length;
  for (let i = 1; i < trailingNewlines; i++) blocks.push({ id: genId(), type: "p", content: "" });
  return blocks;
}

/**
 * Display numbers for a sibling list. A contiguous run of numbered items starts
 * at the first item's `start` (default 1) and increments; any non-numbered
 * sibling breaks the run. This is the single source of truth for both on-screen
 * markers and Markdown serialization, so numbers always re-sequence on
 * insert/delete/reorder ("sequence rebuild").
 */
export function computeListNumbers(siblings: readonly Block[]): Map<string, number> {
  const out = new Map<string, number>();
  let counter: number | null = null;
  for (const b of siblings) {
    if (b.type === "numbered") {
      counter = counter === null ? Math.max(1, b.start ?? 1) : counter + 1;
      out.set(b.id, counter);
    } else {
      counter = null;
    }
  }
  return out;
}

/** Keep an explicit `start` only on the first item of each numbered run (and
 *  drop it when it's the default 1); a run's later items always auto-increment,
 *  so their parsed numbers are intentionally discarded (CommonMark behaviour). */
function normalizeNumbering(blocks: Block[]): void {
  let runStart = true;
  for (const b of blocks) {
    if (b.type === "numbered") {
      if (runStart) {
        if ((b.start ?? 1) <= 1) delete b.start;
        runStart = false;
      } else {
        delete b.start;
      }
    } else {
      runStart = true;
    }
    if (b.children) normalizeNumbering(b.children);
  }
}

/** Editor block tree -> body Markdown. Empty paragraphs are dropped, except a
 *  run at the very end: those trailing blank lines are kept so a gap the user
 *  left at the bottom of the document survives the round-trip. */
export function bodyFromBlocks(blocks: Block[]): string {
  const core = renderContainer(blocks, 0).join("\n").replace(/\n+$/, "");
  const trailing = trailingEmptyParagraphs(blocks);
  return trailing > 0 ? `${core}${"\n".repeat(trailing + 1)}` : core;
}

/** Count the run of empty top-level paragraphs at the end of the document. */
function trailingEmptyParagraphs(blocks: readonly Block[]): number {
  let n = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.type === "p" && b.content.trim() === "" && !b.children?.length) n++;
    else break;
  }
  return n;
}

export function shortcutFromInput(text: string, key: " " | "Enter"): Shortcut | null {
  if (key === " ") {
    if (text === "# ") return { type: "h1", content: "" };
    if (text === "## ") return { type: "h2", content: "" };
    if (text === "### ") return { type: "h3", content: "" };
    if (text === "> ") return { type: "quote", content: "" };
    if (/^[-*+] $/.test(text)) return { type: "bullet", content: "" };
    const numbered = text.match(/^(\d+)[.)] $/);
    if (numbered) return { type: "numbered", content: "", start: parseInt(numbered[1]!, 10) };

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

    const parsed =
      parseListItem(lines, i, minIndent) ??
      parseTableBlock(lines, i, minIndent) ??
      parseLeafBlock(lines, i, minIndent);
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
  if (info.type === "numbered" && info.num != null) block.start = info.num;

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

// ---- GFM pipe tables ----
const RE_DELIM_CELL = /^\s*:?-+:?\s*$/;

/** True if a GFM table begins at line `i`: a pipe row immediately followed by a
 *  delimiter row (e.g. `| :--- | ---: |`). */
function looksLikeTableAt(lines: string[], i: number, minIndent: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  if (head == null || delim == null) return false;
  if (leadingIndent(head) < minIndent || leadingIndent(delim) < minIndent) return false;
  const headText = stripIndent(head, minIndent);
  const delimText = stripIndent(delim, minIndent);
  if (!headText.includes("|") || !delimText.includes("|")) return false;
  const cells = splitTableRow(delimText);
  return cells.length > 0 && cells.every((c) => RE_DELIM_CELL.test(c));
}

/** Split a table row into trimmed cells, honoring `\|` escapes and dropping the
 *  empty cells produced by the outer (leading/trailing) pipes. */
function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  if (cells.length && cells[0]!.trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

function alignFromDelim(cell: string): ColAlign {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(":");
  const right = trimmed.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function padRow(cells: string[], cols: number): string[] {
  const out = cells.slice(0, cols);
  while (out.length < cols) out.push("");
  return out;
}

function parseTableBlock(lines: string[], start: number, minIndent: number): Parsed | null {
  if (!looksLikeTableAt(lines, start, minIndent)) return null;
  const header = splitTableRow(stripIndent(lines[start]!, minIndent));
  const cols = Math.max(1, header.length);
  const align = splitTableRow(stripIndent(lines[start + 1]!, minIndent)).map(alignFromDelim);
  const rows: string[][] = [padRow(header, cols)];
  let i = start + 2;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "" || leadingIndent(raw) < minIndent) break;
    const text = stripIndent(raw, minIndent);
    if (!text.includes("|")) break;
    rows.push(padRow(splitTableRow(text), cols));
  }
  while (align.length < cols) align.push(null);
  align.length = cols;
  return { block: { id: genId(), type: "table", content: "", rows, align }, next: i };
}

function delimCell(a: ColAlign): string {
  switch (a) {
    case "left":
      return ":---";
    case "center":
      return ":---:";
    case "right":
      return "---:";
    default:
      return "---";
  }
}

function renderTable(block: Block, indent: number): string[] {
  const pad = " ".repeat(indent);
  const rows = block.rows ?? [];
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const align = block.align ?? [];
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const renderRow = (cells: string[]) => `${pad}| ${padRow(cells, cols).map(esc).join(" | ")} |`;
  const delim = `${pad}| ${Array.from({ length: cols }, (_, c) => delimCell(align[c] ?? null)).join(" | ")} |`;
  const header = rows[0] ?? Array.from({ length: cols }, () => "");
  return [renderRow(header), delim, ...rows.slice(1).map(renderRow)];
}

function parseParagraph(lines: string[], start: number, minIndent: number): Parsed {
  const content: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "" || leadingIndent(raw) < minIndent) break;
    if (content.length && (startsLeafBlock(raw, minIndent) || looksLikeTableAt(lines, i, minIndent))) break;
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

  m = text.match(/^(\d+)[.)]\s+(.*)$/);
  if (m) return { indent, type: "numbered", content: m[2]!, num: parseInt(m[1]!, 10) };

  m = text.match(/^[-*+]\s+(.*)$/);
  if (m) return { indent, type: "bullet", content: m[1]! };

  return null;
}

function renderContainer(blocks: readonly Block[] | undefined, indent: number): string[] {
  const out: string[] = [];
  let prev: Block | null = null;
  const persisted = (blocks ?? []).filter(shouldPersist);
  const numbers = computeListNumbers(persisted);

  for (const block of persisted) {
    if (out.length && shouldSeparate(prev, block)) out.push("");
    out.push(...renderBlock(block, indent, numbers.get(block.id) ?? 1));
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
    case "table":
      return renderTable(block, indent);
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
    if (!isListType(children[0]!.type) && block.content.trim() !== "") lines.push("");
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
  if (block.type === "table") return (block.rows ?? []).some((r) => r.some((c) => c.trim() !== ""));
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

/** Languages offered in the code block's language dropdown. Values are
 *  highlight.js language ids (also accepted by cleanLang for round-trip). */
export const COMMON_LANGS: { id: string; label: string }[] = [
  { id: "", label: "纯文本" },
  { id: "bash", label: "Bash" },
  { id: "shell", label: "Shell" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "json", label: "JSON" },
  { id: "python", label: "Python" },
  { id: "go", label: "Go" },
  { id: "rust", label: "Rust" },
  { id: "java", label: "Java" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "csharp", label: "C#" },
  { id: "sql", label: "SQL" },
  { id: "yaml", label: "YAML" },
  { id: "xml", label: "HTML / XML" },
  { id: "css", label: "CSS" },
  { id: "scss", label: "SCSS" },
  { id: "markdown", label: "Markdown" },
  { id: "php", label: "PHP" },
  { id: "ruby", label: "Ruby" },
  { id: "swift", label: "Swift" },
  { id: "kotlin", label: "Kotlin" },
  { id: "objectivec", label: "Objective-C" },
  { id: "perl", label: "Perl" },
  { id: "lua", label: "Lua" },
  { id: "makefile", label: "Makefile" },
  { id: "ini", label: "INI / TOML" },
  { id: "diff", label: "Diff" },
];

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
  { type: "table", ic: "table", t: "表格", d: "插入表格" },
  { type: "divider", ic: "minus", t: "分隔线", d: "水平分隔" },
];
