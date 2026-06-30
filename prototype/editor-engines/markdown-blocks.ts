export type MarkdownBlockType =
  | "heading"
  | "paragraph"
  | "list"
  | "task"
  | "code_fence"
  | "quote"
  | "table"
  | "media"
  | "divider"
  | "html_fence";

export interface MarkdownLine {
  number: number;
  from: number;
  to: number;
  text: string;
}

export interface MarkdownBlock {
  id: string;
  type: MarkdownBlockType;
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  text: string;
  summary: string;
}

const fencePattern = /^ {0,3}(`{3,}|~{3,})([^`]*)$/;
const headingPattern = /^ {0,3}#{1,6}(?:\s+|$)/;
const dividerPattern = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const quotePattern = /^ {0,3}>/;
const listPattern = /^(\s*)([-+*]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.*)$/;
const mediaPattern =
  /^\s*(?:!\[[^\]]*]\([^)]+\)|\[[^\]]+]\((?:[^)\s]+(?:\s+"[^"]*")?)\))\s*$/;
const tableSeparatorPattern =
  /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

export function splitMarkdownLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let from = 0;
  let lineNumber = 1;

  for (let index = 0; index <= markdown.length; index += 1) {
    if (index === markdown.length || markdown.charCodeAt(index) === 10) {
      lines.push({
        number: lineNumber,
        from,
        to: index,
        text: markdown.slice(from, index),
      });
      from = index + 1;
      lineNumber += 1;
    }
  }

  return lines;
}

export function scanMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = splitMarkdownLines(markdown);
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line) {
      break;
    }

    if (line.text.trim() === "") {
      const start = index;
      while (index < lines.length && lines[index]?.text.trim() === "") {
        index += 1;
      }
      blocks.push(makeBlock("paragraph", lines, start, index - 1, markdown));
      continue;
    }

    const fence = line.text.match(fencePattern);
    if (fence) {
      const start = index;
      const marker = fence[1] ?? "```";
      const language = (fence[2] ?? "").trim();
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index]?.text ?? "";
        if (candidate.trimStart().startsWith(marker)) {
          index += 1;
          break;
        }
        index += 1;
      }
      blocks.push(
        makeBlock(language === "mh-html" ? "html_fence" : "code_fence", lines, start, index - 1, markdown),
      );
      continue;
    }

    if (headingPattern.test(line.text)) {
      blocks.push(makeBlock("heading", lines, index, index, markdown));
      index += 1;
      continue;
    }

    if (dividerPattern.test(line.text.trim())) {
      blocks.push(makeBlock("divider", lines, index, index, markdown));
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const start = index;
      index += 2;
      while (index < lines.length && looksLikeTableRow(lines[index]?.text ?? "")) {
        index += 1;
      }
      blocks.push(makeBlock("table", lines, start, index - 1, markdown));
      continue;
    }

    if (quotePattern.test(line.text)) {
      const start = index;
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index]?.text ?? "";
        if (candidate.trim() === "" || quotePattern.test(candidate)) {
          index += 1;
          continue;
        }
        break;
      }
      blocks.push(makeBlock("quote", lines, start, index - 1, markdown));
      continue;
    }

    if (listPattern.test(line.text)) {
      const start = index;
      let hasTask = Boolean(line.text.match(listPattern)?.[3]);
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index]?.text ?? "";
        const listMatch = candidate.match(listPattern);
        if (listMatch) {
          hasTask ||= Boolean(listMatch[3]);
          index += 1;
          continue;
        }
        if (candidate.trim() === "") {
          const nextMatch = (lines[index + 1]?.text ?? "").match(listPattern);
          const nextIndent = (nextMatch?.[1] ?? "").replace(/\t/g, "  ").length;
          if (nextMatch && nextIndent === 0) {
            break;
          }
          index += 1;
          continue;
        }
        if (/^\s{2,}\S/.test(candidate)) {
          index += 1;
          continue;
        }
        break;
      }
      blocks.push(makeBlock(hasTask ? "task" : "list", lines, start, index - 1, markdown));
      continue;
    }

    if (mediaPattern.test(line.text)) {
      blocks.push(makeBlock("media", lines, index, index, markdown));
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index]?.text ?? "";
      if (
        candidate.trim() === "" ||
        fencePattern.test(candidate) ||
        headingPattern.test(candidate) ||
        dividerPattern.test(candidate.trim()) ||
        quotePattern.test(candidate) ||
        listPattern.test(candidate) ||
        mediaPattern.test(candidate) ||
        isTableStart(lines, index)
      ) {
        break;
      }
      index += 1;
    }
    blocks.push(makeBlock("paragraph", lines, start, index - 1, markdown));
  }

  return blocks;
}

export function findBlockAt(blocks: readonly MarkdownBlock[], position: number): MarkdownBlock | undefined {
  return blocks.find((block) => position >= block.from && position <= block.to);
}

export function extractFence(block: MarkdownBlock): { language: string; body: string; marker: string } {
  const lines = block.text.endsWith("\n") ? block.text.slice(0, -1).split("\n") : block.text.split("\n");
  const firstLine = lines[0] ?? "";
  const markerMatch = firstLine.match(fencePattern);
  const marker = markerMatch?.[1] ?? "```";
  const language = (markerMatch?.[2] ?? "").trim();
  const lastLine = lines.length > 1 && (lines.at(-1) ?? "").trimStart().startsWith(marker) ? 1 : 0;
  const bodyLines = lines.slice(1, lines.length - lastLine);
  return { language, body: bodyLines.join("\n"), marker };
}

export function splitTableRow(row: string): string[] {
  const trimmed = row.trim();
  const content = stripOuterPipes(trimmed);
  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (const char of content) {
    if (escaped) {
      current += char === "|" ? "|" : `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (escaped) {
    current += "\\";
  }
  cells.push(current.trim());
  return cells;
}

export function isTaskLine(line: string): boolean {
  return Boolean(line.match(listPattern)?.[3]);
}

export function getListLineMatch(line: string): RegExpMatchArray | null {
  return line.match(listPattern);
}

function makeBlock(
  type: MarkdownBlockType,
  lines: readonly MarkdownLine[],
  startIndex: number,
  endIndex: number,
  markdown: string,
): MarkdownBlock {
  const startLine = lines[startIndex] ?? lines[lines.length - 1];
  const endLine = lines[endIndex] ?? startLine;
  const from = startLine?.from ?? 0;
  const toLineEnd = endLine ? endLine.to : from;
  const to = endIndex < lines.length - 1 ? toLineEnd + 1 : toLineEnd;
  const text = markdown.slice(from, to);
  const summary = summarizeBlockText(text);

  return {
    id: `${type}-${from}-${to}`,
    type,
    from,
    to,
    startLine: startLine?.number ?? 1,
    endLine: endLine?.number ?? startLine?.number ?? 1,
    text,
    summary,
  };
}

function summarizeBlockText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 69)}...` : compact || "empty";
}

function isTableStart(lines: readonly MarkdownLine[], index: number): boolean {
  const current = lines[index]?.text ?? "";
  const next = lines[index + 1]?.text ?? "";
  return looksLikeTableRow(current) && tableSeparatorPattern.test(next);
}

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && !fencePattern.test(trimmed);
}

function stripOuterPipes(row: string): string {
  let start = 0;
  let end = row.length;
  if (row[start] === "|") {
    start += 1;
  }
  if (row[end - 1] === "|" && row[end - 2] !== "\\") {
    end -= 1;
  }
  return row.slice(start, end);
}
