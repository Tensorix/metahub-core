// Client-side block model for the document editor. This layer is intentionally
// richer than core's block splitter: the WebUI can model nested list items and
// code fence languages, then save the whole document back as canonical Markdown
// through the existing document body API.

export type BlockType =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "bullet"
  | "numbered"
  | "todo"
  | "quote"
  | "code"
  | "table"
  | "divider"
  // Block-level "void" embeds. Not contentEditable: rendered as standalone
  // widgets (selectable, resizable, draggable). They still serialize to plain
  // Markdown so core stays byte-only — image/video/audio as `![](url)`, file as a
  // `[](/blob/..)` link, html as a reserved ```mh-html fence (see renderBlock /
  // matchMediaLine). A block is promoted to a void type only when its whole text
  // IS the embed; inline images/links inside prose stay inline.
  | "image"
  | "video"
  | "audio"
  | "file"
  | "html"
  // Transient, in-memory only: a placeholder shown at the insertion point while a
  // file uploads. Never parsed from Markdown and never serialized (shouldPersist
  // false, renderBlock no-op) — it's replaced by the real media block on success
  // or removed on failure. `name` holds the uploading filename.
  | "uploading";

export type ColAlign = "left" | "center" | "right" | null;

export interface Block {
  id: string;
  type: BlockType;
  content: string; // inner text, without the markdown prefix/fence (html: raw HTML)
  checked?: boolean; // todo only
  lang?: string; // code only
  start?: number; // numbered only: explicit start number of a run (first item)
  children?: Block[]; // list items only
  rows?: string[][]; // table only: rows[0] is the header; each cell is inline markdown
  align?: ColAlign[]; // table only: per-column text alignment
  src?: string; // image/video/audio/file only: the embed URL (usually /blob/<hash>.<ext>)
  name?: string; // image/video/audio/file only: alt / display filename
  width?: number; // image only: rendered width in px (round-trips as a ?w= query)
  size?: number; // file only: byte size (round-trips in the link title)
  /** Non-list blocks only: extra nesting levels (2 indent columns each) beyond the
   *  containing list item — a free-standing indented heading/quote/code/table/media
   *  keeps its 24px-grid level through a blocks round-trip. INVARIANT: only the
   *  blocksFromBody parse path sets this. textToBlock and the editor void pipeline
   *  must never — the void commit() already re-prefixes the source indent, so a
   *  block-side indent would double-pad and walk the block rightward on every edit. */
  indent?: number;
}

/** Embeds carried by the `![](url)` / `[](url)` / ```mh-html grammar — promoted to
 *  a block-level widget only when the block's whole text is the embed. */
export type MediaKind = "image" | "video" | "audio" | "file";

// HTML_FENCE moved to ../core/md/grammar.ts (re-exported below).

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "ogv", "mkv", "ogg"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "flac", "opus", "oga", "weba"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "apng"]);

/** Void-embed block type for an uploaded file, by its MIME type. Drives the
 *  drop/paste pipeline (image|video|audio render inline, everything else → file). */
export function mediaKindFromMime(mime: string): MediaKind {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "file";
}

/** Lowercased file extension of a URL (no query/fragment), or "". */
function extOf(url: string): string {
  const clean = url.split(/[?#]/, 1)[0] ?? url;
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Which `![](url)` embed a media URL is, by extension. Image syntax never maps
 *  to "file": an unknown extension written as `![]()` is treated as an image. */
function imageSyntaxKind(ext: string): "image" | "video" | "audio" {
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "image";
}

/** Split a media URL into its base src and an optional `w=` width, preserving any
 *  other query params / fragment (external images may carry signed tokens). */
function parseMediaUrl(url: string): { src: string; width?: number } {
  const hash = url.indexOf("#");
  const frag = hash >= 0 ? url.slice(hash) : "";
  const noFrag = hash >= 0 ? url.slice(0, hash) : url;
  const q = noFrag.indexOf("?");
  if (q < 0) return { src: url };
  const base = noFrag.slice(0, q);
  let width: number | undefined;
  const kept: string[] = [];
  for (const p of noFrag.slice(q + 1).split("&").filter(Boolean)) {
    const m = p.match(/^w=(\d+)$/);
    if (m) width = parseInt(m[1]!, 10);
    else kept.push(p);
  }
  return { src: base + (kept.length ? "?" + kept.join("&") : "") + frag, width };
}

/** Re-attach an image block's width as a `?w=` query on its src. */
function mediaUrl(b: Block): string {
  const url = b.src ?? "";
  if (b.type !== "image" || !b.width || b.width <= 0) return url;
  return url + (url.includes("?") ? "&" : "?") + "w=" + Math.round(b.width);
}

/** Strip the chars that would break `![alt](url)` / `[text](url)` grammar. */
function safeLabel(s: string): string {
  return s.replace(/[[\]()]/g, "").trim();
}

/** A line that is solely one embed → its void block draft, else null. Media use
 *  `![alt](url)` (kind by extension); file uses a `[name](/blob/..)` link so a
 *  plain standalone hyperlink stays a paragraph. */
export function matchMediaLine(line: string): BlockDraft | null {
  const t = line.trim();
  let m = t.match(/^!\[([^\]]*)\]\(([^\s)]+)\)$/);
  if (m) {
    const { src, width } = parseMediaUrl(m[2]!);
    const type = imageSyntaxKind(extOf(src));
    const b: BlockDraft = { type, content: "", src, name: m[1]! };
    if (type === "image" && width) b.width = width;
    return b;
  }
  m = t.match(/^\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)$/);
  if (m && m[2]!.startsWith("/blob/")) {
    const b: BlockDraft = { type: "file", content: "", src: m[2]!, name: m[1]! };
    if (m[3] != null && /^\d+$/.test(m[3])) b.size = parseInt(m[3], 10);
    return b;
  }
  return null;
}

function isMediaType(type: BlockType): boolean {
  return type === "image" || type === "video" || type === "audio" || type === "file";
}

export type BlockDraft = Omit<Block, "id">;

let counter = 0;
export function genId(): string {
  return `blk_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}

const LIST_TYPES = new Set<BlockType>(["bullet", "numbered", "todo"]);
const HEADING_TYPES = new Set<BlockType>(["h1", "h2", "h3", "h4", "h5", "h6"]);

// The line grammar (RE table, matchListLine/matchQuoteLine, indent/fence/table
// helpers) moved to core (../core/md/grammar.ts) so the share renderer parses
// through the exact same predicates. Re-exported here so the many webui
// consumers (cm6/blockmodel.ts etc.) keep their import paths.
export {
  RE,
  HTML_FENCE,
  matchQuoteLine,
  matchListLine,
  leadingIndent,
  stripIndent,
  isFenceClose,
  cleanLang,
  looksLikeTableAt,
  splitTableRow,
  type ListLine,
} from "../core/md/grammar.ts";
import {
  RE,
  HTML_FENCE,
  matchQuoteLine,
  matchListLine,
  leadingIndent,
  stripIndent,
  isFenceClose,
  cleanLang,
  looksLikeTableAt,
  splitTableRow,
} from "../core/md/grammar.ts";

export interface Parsed {
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

export function isHeadingType(type: BlockType): boolean {
  return HEADING_TYPES.has(type);
}

// Starter table for slash-insert / block conversion: header row + 1 body row,
// two empty columns.
function starterTableRows(): string[][] {
  return [
    ["", ""],
    ["", ""],
  ];
}

/** Set a block's type and (re)initialize its per-type fields from `draft`.
 *  The single source of truth for the type↔field invariants (todo.checked,
 *  code.lang, numbered.start, table.rows/align): both makeBlock and the
 *  editor's convert go through here, so the two can't drift. Children are the
 *  caller's concern (a conversion may keep them, a fresh block sets its own). */
export function applyBlockDraft(b: Block, type: BlockType, draft: Partial<BlockDraft>): void {
  b.type = type;
  b.content = draft.content ?? "";
  if (type === "todo") b.checked = draft.checked ?? false;
  else delete b.checked;
  if (type === "code") b.lang = draft.lang ?? "";
  else delete b.lang;
  if (type === "numbered" && draft.start != null && draft.start > 1) b.start = draft.start;
  else delete b.start;
  if (type === "table") {
    b.rows = draft.rows ? draft.rows.map((r) => [...r]) : starterTableRows();
    b.align = draft.align ? [...draft.align] : new Array(b.rows[0]!.length).fill(null);
  } else {
    delete b.rows;
    delete b.align;
  }
  // Free-standing indent is a non-list concept (list nesting lives in children);
  // conversions must not leak a stale level into the new type's serialization.
  if (!isListType(type) && draft.indent && draft.indent > 0) b.indent = draft.indent;
  else delete b.indent;
  if (isMediaType(type) || type === "uploading") {
    b.src = draft.src ?? "";
    if (draft.name != null) b.name = draft.name;
    else delete b.name;
    if (type === "image" && draft.width) b.width = draft.width;
    else delete b.width;
    if (type === "file" && draft.size != null) b.size = draft.size;
    else delete b.size;
  } else {
    delete b.src;
    delete b.name;
    delete b.width;
    delete b.size;
  }
}

/** Construct a fresh block of `type` from a draft. */
export function makeBlock(type: BlockType, draft: Partial<BlockDraft> = {}): Block {
  const block: Block = { id: genId(), type, content: "" };
  applyBlockDraft(block, type, draft);
  if (isListType(type) && draft.children?.length) block.children = draft.children;
  return block;
}

/** Parse one Markdown-ish block text into a typed editor block. */
export function textToBlock(text: string): BlockDraft {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const fence = firstLine.match(RE.fenceOpen);
  if (fence) {
    const lines = text.split("\n");
    if (RE.fenceOpen.test(lines[0]!)) lines.shift();
    if (lines.length && isFenceClose(lines[lines.length - 1]!, fence[1]![0]!, fence[1]!.length)) lines.pop();
    const lang = cleanLang(fence[2] ?? "");
    if (lang === HTML_FENCE) return { type: "html", content: lines.join("\n") };
    return { type: "code", content: lines.join("\n"), lang };
  }
  if (RE.divider.test(text.trim()) && !text.includes("\n")) return { type: "divider", content: "" };
  if (!text.includes("\n")) {
    const media = matchMediaLine(text);
    if (media) return media;
  }

  let m: RegExpMatchArray | null;
  if ((m = firstLine.match(RE.h))) {
    const level = m[1]!.length as 1 | 2 | 3;
    return { type: (`h${level}` as BlockType), content: m[2]! };
  }
  if ((m = firstLine.match(RE.todo)))
    return { type: "todo", content: m[2]!, checked: m[1]!.toLowerCase() === "x" };
  if ((m = firstLine.match(RE.numbered))) return { type: "numbered", content: m[2]!, start: parseInt(m[1]!, 10) };
  if ((m = firstLine.match(RE.bullet))) return { type: "bullet", content: m[1]! };
  if (matchQuoteLine(firstLine) !== null) {
    const content = text
      .split("\n")
      .map((l) => matchQuoteLine(l.replace(/^\s*/, "")) ?? l)
      .join("\n");
    return { type: "quote", content };
  }
  return { type: "p", content: text };
}

/** Serialize one typed block back to canonical Markdown. */
export function blockToText(b: Block): string {
  return renderBlock(b, 0, 1).join("\n");
}

/** Serialize a flat selection of blocks to Markdown, re-sequencing numbered
 *  runs across the selection (copy/cut). Joined tightly like blockToText, not
 *  with bodyFromBlocks's blank-line separators. */
export function blocksToText(selection: readonly Block[]): string {
  const numbers = computeListNumbers(selection.filter((b) => !isBlankSpacer(b)));
  return selection
    .map((b) => renderBlock(b, 0, numbers.get(b.id) ?? 1).join("\n"))
    .join("\n");
}

/** Body Markdown -> editor block tree.
 *
 *  Deliberately NO healLegacyMarkdown here: `- [ ]` is ambiguous between a
 *  legacy empty todo (at-rest) and a bullet the user is typing RIGHT NOW, and
 *  this parser serves live editor text (convert/export paths) where the
 *  mid-typing reading must win. At-rest bodies reach the block tree through
 *  the editor load (CmDocBody norm) or the share renderer — both heal. */
export function blocksFromBody(body: string | null | undefined): Block[] {
  const normalized = (body ?? "").replace(/\r\n?/g, "\n");
  const lines = normalized ? normalized.split("\n") : [];
  const blocks = parseContainer(lines, 0, 0).blocks;
  normalizeNumbering(blocks);
  // Blank lines the user left at the very end (for spacing) become empty
  // paragraphs so the gap survives a save/reload. One trailing newline is the
  // conventional file terminator and is ignored; every newline beyond it is a
  // real blank line. (Interior blank runs are handled inside parseContainer.)
  const trailingNewlines = normalized.length - normalized.replace(/\n+$/, "").length;
  for (let i = 1; i < trailingNewlines; i++) blocks.push({ id: genId(), type: "p", content: "" });
  return blocks;
}

/** An empty paragraph — pure vertical spacing the user inserted (a blank line),
 *  not real content. Serialized as a blank line instead of dropped, so the gap
 *  survives. An empty *list item* is NOT a spacer: it is a typed block whose
 *  marker (`- `, `2. `, `- [ ] `) carries its kind through Markdown, so it keeps
 *  its type across a save/reload. Delete the marker and it becomes a `p` — a
 *  plain blank line. See [[blocks]] doc-block model. */
export function isBlankSpacer(b: Block): boolean {
  return b.type === "p" && b.content.trim() === "" && !b.children?.length;
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

/** Editor block tree -> body Markdown. Empty paragraphs are the user's vertical
 *  spacing: each becomes an extra blank line (beyond the standard single-blank
 *  separator), so interior and trailing gaps survive the round-trip. Empty list
 *  items keep their marker; empty tables/code are dropped. One recursive routine
 *  renders every container (top level and nested list children) so gaps survive
 *  at any depth. */
export function bodyFromBlocks(blocks: Block[]): string {
  return serializeContainer(blocks, 0, true).join("\n");
}

/** Render one container's blocks at `indent`. Empty paragraphs are counted as
 *  extra blank lines between the real blocks; at the document end (`isTop`) a
 *  trailing run also keeps the conventional terminator newline so trailing empty
 *  paragraphs round-trip. */
function serializeContainer(blocks: readonly Block[], indent: number, isTop: boolean): string[] {
  // Spacers don't take part in list numbering, so a blank line between numbered
  // items keeps the run going (1, 2) instead of resetting.
  const numbers = computeListNumbers(blocks.filter((b) => !isBlankSpacer(b)));
  const out: string[] = [];
  let prev: Block | null = null;
  let extraBlanks = 0; // empty paragraphs seen since the last rendered block
  for (const b of blocks) {
    if (isBlankSpacer(b)) {
      if (out.length) extraBlanks++; // leading empties are dropped
      continue;
    }
    if (!shouldPersist(b)) continue;
    if (out.length) {
      // A standard 1-line separator, unless two list items sit tight together
      // (no blanks). Once the user put empty paragraphs between them, force the
      // separator too so the run is `1 + extra` blank lines.
      const sep = shouldSeparate(prev, b) || extraBlanks > 0 ? 1 : 0;
      for (let k = 0; k < sep + extraBlanks; k++) out.push("");
    }
    out.push(...renderBlock(b, indent, numbers.get(b.id) ?? 1));
    prev = b;
    extraBlanks = 0;
  }
  // Trailing empty paragraphs: their blank lines plus, only at the very end of
  // the document, the conventional terminator newline.
  if (out.length && extraBlanks > 0)
    for (let k = 0; k < extraBlanks + (isTop ? 1 : 0); k++) out.push("");
  return out;
}

export function shortcutFromInput(text: string, key: " " | "Enter"): Shortcut | null {
  if (key === " ") {
    const heading = text.match(/^(#{1,6}) $/);
    if (heading) return { type: `h${heading[1]!.length}` as BlockType, content: "" };
    if (text === "> ") return { type: "quote", content: "" };
    if (/^[-*+] $/.test(text)) return { type: "bullet", content: "" };
    const numbered = text.match(/^(\d+)[.)] $/);
    if (numbered) return { type: "numbered", content: "", start: parseInt(numbered[1]!, 10) };

    const todo = text.match(/^[-*+]\s+\[([ xX])\]\s*$/);
    if (todo) return { type: "todo", content: "", checked: todo[1]!.toLowerCase() === "x" };
    return null;
  }

  const code = text.match(/^```([A-Za-z0-9_+.#-]*)$/);
  if (code) return { type: "code", content: "", lang: cleanLang(code[1] ?? "") };
  return null;
}

// In a bullet, "[ ]" / "[x]" before the caret followed by a space promotes it
// to a todo. "- [ ]" is typed in two stages — "- "→bullet, then "[ ] " completes
// the prefix — so the todo marker is only recognised once the block is already a
// bullet (its "- " marker is rendered, not part of the editable text).
export function bulletTodoShortcut(before: string): { checked: boolean } | null {
  const m = before.match(/^\[([ xX])\]$/);
  return m ? { checked: m[1]!.toLowerCase() === "x" } : null;
}

function parseContainer(
  lines: string[],
  start: number,
  minIndent: number,
): { blocks: Block[]; next: number } {
  const blocks: Block[] = [];
  let i = start;
  let blankRun = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      // A blank run is consumed only if more content at this container's indent
      // follows it; a run before a shallower line (e.g. the next top-level block
      // after a list item) belongs to the parent — leave it so the parent counts
      // it (otherwise a list item would swallow the blank lines that separate it
      // from the next block, losing user spacing between list items).
      let j = i;
      while (j < lines.length && lines[j]!.trim() === "") j++;
      if (j >= lines.length || leadingIndent(lines[j]!) < minIndent) break;
      blankRun += j - i;
      i = j;
      continue;
    }
    if (leadingIndent(line) < minIndent) break;

    // Blank lines between blocks beyond the single separator are spacing the user
    // inserted — materialize the extras as empty paragraphs so they survive the
    // round-trip, at every nesting level (the run already belongs to this
    // container; deeper/shallower runs broke out above). Trailing blanks are left
    // for blocksFromBody.
    if (blocks.length && blankRun > 1)
      for (let k = 1; k < blankRun; k++) blocks.push({ id: genId(), type: "p", content: "" });
    blankRun = 0;

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
  if (info.type === "numbered" && info.num != null) block.start = info.num;

  const child = parseContainer(lines, start + 1, info.indent + 2);
  if (child.blocks.length) block.children = child.blocks;
  return { block, next: child.next };
}

function parseLeafBlock(lines: string[], start: number, minIndent: number): Parsed {
  // Classify on the line's OWN indentation, like the CM6 scan's classifyLine:
  // whole 2-column levels beyond the container become the block's `indent`, so
  // `  # x` is an indented heading on every surface, not a paragraph. An odd
  // remainder column is canonicalized away (level math floors, matching the
  // renderer's hidden-indent rule). Sub-parsers run at the deepened base so an
  // indented fence/quote/table gets clean content instead of leaked whitespace.
  const extra = Math.max(0, leadingIndent(lines[start]!) - minIndent);
  const indent = Math.floor(extra / 2);
  const base = minIndent + extra;
  const withIndent = (p: Parsed): Parsed => {
    if (indent > 0 && !isListType(p.block.type)) p.block.indent = indent;
    return p;
  };

  // Table before fence/heading — preserves the pre-existing precedence from
  // parseContainer's old parseListItem ?? parseTableBlock ?? parseLeafBlock chain.
  const table = parseTableBlock(lines, start, base);
  if (table) return withIndent(table);

  const first = stripIndent(lines[start]!, base);
  const fence = first.match(RE.fenceOpen);
  if (fence) {
    const code = parseCodeBlock(lines, start, base, fence);
    if (code) return withIndent(code);
  }

  if (RE.divider.test(first.trim())) {
    return withIndent({ block: { id: genId(), type: "divider", content: "" }, next: start + 1 });
  }

  const heading = first.match(RE.h);
  if (heading) {
    return withIndent({
      block: {
        id: genId(),
        type: `h${heading[1]!.length}` as BlockType,
        content: heading[2]!,
      },
      next: start + 1,
    });
  }

  if (matchQuoteLine(first) !== null) return withIndent(parseQuoteBlock(lines, start, base));
  // A line that is solely one embed becomes its own void block; anything else
  // (incl. an image with trailing prose) falls through to the paragraph parser
  // and renders inline as before.
  const media = matchMediaLine(first);
  if (media) return withIndent({ block: { id: genId(), ...media }, next: start + 1 });
  return withIndent(parseParagraph(lines, start, base));
}

function parseCodeBlock(
  lines: string[],
  start: number,
  minIndent: number,
  open: RegExpMatchArray,
): Parsed | null {
  const fence = open[1]!;
  const content: string[] = [];
  let i = start + 1;
  let closed = false;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    const stripped = stripIndent(raw, minIndent);
    if (isFenceClose(stripped, fence[0]!, fence.length)) {
      closed = true;
      i++;
      break;
    }
    content.push(stripped);
  }
  // An unclosed fence is prose that happens to start with ``` (pasted text, a
  // stray line) — opening a code block on it would swallow everything below.
  // Bail out and let the caller fall through to the paragraph parser. Explicit
  // creation paths (typing shortcut, textToBlock conversion) stay lenient.
  if (!closed) return null;
  const lang = cleanLang(open[2] ?? "");
  if (lang === HTML_FENCE)
    return { block: { id: genId(), type: "html", content: content.join("\n") }, next: i };
  return {
    block: { id: genId(), type: "code", content: content.join("\n"), lang },
    next: i,
  };
}

function parseQuoteBlock(lines: string[], start: number, minIndent: number): Parsed {
  const content: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "" || leadingIndent(raw) < minIndent) break;
    const quote = matchQuoteLine(stripIndent(raw, minIndent));
    if (quote === null) break;
    content.push(quote);
  }
  return { block: { id: genId(), type: "quote", content: content.join("\n") }, next: i };
}

// ---- GFM pipe tables ----
// looksLikeTableAt / splitTableRow / RE_DELIM_CELL moved to ../core/md/grammar.ts.

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

export function parseTableBlock(lines: string[], start: number, minIndent: number): Parsed | null {
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

// A paragraph line that looks like a fence opener would re-open a code fence on
// the next load and swallow the rest of the document — so the serializer hides
// it behind a leading backslash and the paragraph parser strips exactly one.
// Lines already carrying backslashes before the fence get one more, so literal
// "\```" text round-trips too (escape-the-escape).
const RE_FENCE_LIKE = /^\\*(?:`{3,}|~{3,})/;

function escapeFenceLine(line: string): string {
  return RE_FENCE_LIKE.test(line) ? `\\${line}` : line;
}

function unescapeFenceLine(line: string): string {
  return line.startsWith("\\") && RE_FENCE_LIKE.test(line.slice(1)) ? line.slice(1) : line;
}

function parseParagraph(lines: string[], start: number, minIndent: number): Parsed {
  const content: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "" || leadingIndent(raw) < minIndent) break;
    if (content.length && (startsLeafBlock(raw, minIndent) || looksLikeTableAt(lines, i, minIndent))) break;
    content.push(unescapeFenceLine(stripIndent(raw, minIndent)));
  }
  return { block: { id: genId(), type: "p", content: content.join("\n") }, next: i };
}

function startsLeafBlock(line: string, minIndent: number): boolean {
  if (matchListLine(line, minIndent)) return true;
  // Strip the line's FULL indent (not just minIndent) — classifyLine does, so a
  // deeper-indented heading/quote mid-paragraph must break the paragraph here
  // exactly like it starts its own block on screen.
  const text = stripIndent(line, Number.MAX_SAFE_INTEGER);
  return !!text.match(RE.fenceOpen) || !!text.match(RE.h) || RE.divider.test(text.trim()) || matchQuoteLine(text) !== null;
}

// matchListLine moved to ../core/md/grammar.ts (re-exported above).

function renderBlock(block: Block, indent: number, number: number): string[] {
  indent += 2 * (block.indent ?? 0); // free-standing level on top of the container's
  const pad = " ".repeat(indent);
  if (isHeadingType(block.type))
    return [`${pad}${"#".repeat(Number(block.type.slice(1)))} ${block.content}`];
  switch (block.type) {
    case "bullet":
    case "numbered":
    case "todo":
      return renderListBlock(block, indent, number);
    case "quote":
      // `> ` even for an empty line — the strict grammar needs the space after
      // `>` (a bare `>` is a mid-typing paragraph, not an empty quote line).
      return block.content.split("\n").map((line) => `${pad}> ${line}`);
    case "code": {
      const first = `${pad}\`\`\`${block.lang ? cleanLang(block.lang) : ""}`;
      const body = block.content.split("\n").map((line) => `${pad}${line}`);
      return [first, ...body, `${pad}\`\`\``];
    }
    case "table":
      return renderTable(block, indent);
    case "divider":
      return [`${pad}---`];
    case "image":
    case "video":
    case "audio":
      return [`${pad}![${safeLabel(block.name ?? "")}](${mediaUrl(block)})`];
    case "file": {
      const title = block.size != null ? ` "${block.size}"` : "";
      return [`${pad}[${safeLabel(block.name ?? "文件")}](${block.src ?? ""}${title})`];
    }
    case "html": {
      const first = `${pad}\`\`\`${HTML_FENCE}`;
      const body = block.content.split("\n").map((line) => `${pad}${line}`);
      return [first, ...body, `${pad}\`\`\``];
    }
    case "uploading":
      return []; // transient placeholder — never serialized
    default:
      return block.content.split("\n").map((line) => `${pad}${escapeFenceLine(line)}`);
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
  const children = block.children ?? [];
  const firstReal = children.find((c) => !isBlankSpacer(c) && shouldPersist(c));
  if (firstReal) {
    // A non-list child (paragraph/quote/code under the item) needs a blank line
    // after the marker line; a nested list hugs it. Render every child — including
    // empty-paragraph spacers — through the shared recursive serializer.
    if (!isListType(firstReal.type) && block.content.trim() !== "") lines.push("");
    lines.push(...serializeContainer(children, indent + 2, false));
  }
  return lines;
}

function shouldSeparate(prev: Block | null, next: Block): boolean {
  if (!prev) return false;
  return !(isListType(prev.type) && isListType(next.type));
}

function shouldPersist(block: Block): boolean {
  if (block.type === "divider") return true;
  // A list item is a typed line: even with no content it serializes as its bare
  // marker (`- `, `2. `, `- [ ] `) so its kind survives a Markdown round-trip.
  if (isListType(block.type)) return true;
  if (block.type === "code") return block.content.trim() !== "" || !!block.lang?.trim();
  if (block.type === "table") return (block.rows ?? []).some((r) => r.some((c) => c.trim() !== ""));
  if (block.type === "uploading") return false; // transient — drop from saved Markdown
  if (isMediaType(block.type)) return !!block.src;
  if (block.type === "html") return block.content.trim() !== "";
  return block.content.trim() !== "";
}

// leadingIndent / stripIndent / isFenceClose / cleanLang moved to
// ../core/md/grammar.ts (re-exported above).

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
  { type: "image", ic: "image", t: "图片", d: "上传或拖入图片" },
  { type: "video", ic: "video", t: "视频", d: "上传视频文件" },
  { type: "audio", ic: "audio", t: "音频", d: "上传音频文件" },
  { type: "file", ic: "file", t: "文件", d: "上传任意文件" },
  { type: "html", ic: "htmlTag", t: "HTML", d: "嵌入并渲染 HTML" },
];

/** Block types inserted via a file picker (not a plain text-conversion). */
export function isUploadType(type: BlockType): boolean {
  return type === "image" || type === "video" || type === "audio" || type === "file";
}
