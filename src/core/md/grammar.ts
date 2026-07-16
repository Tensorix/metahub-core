// The SINGLE line-level Markdown grammar for every surface.
//
// Core stores document bodies as Markdown and both parses (core/blocks.ts,
// share SSR) and serializes them, so the grammar lives in core: pure string
// predicates, no DOM/editor imports, safe for the server renderer and the
// static E2EE share shell. Consumers: the CM6 editor scan (webui/cm6/
// blockmodel.ts), the save/load parser + serializer (webui/blocks.ts, which
// re-exports this module), and the share renderer (core/sync/share-render.ts).
// Because they all classify lines through the same predicates, the same bytes
// can never render as different block types on different surfaces.
//
// STRICT rule: every marker — quote included — needs trailing whitespace, so
// nothing renders as a block until the user commits with the space. `> foo`
// and `> ` (an empty quote line, exactly what the serializer emits) are
// quotes; a bare `>` (mid-typing, before the space) and `>foo` are paragraphs.
// Same for todo: `- [ ] x` / `- [ ] ` are todos, `- [ ]` with nothing after
// the bracket is still a bullet whose content is `[ ]`. Compatibility is a
// parse-only change — existing bodies are never rewritten; legacy forms the
// old serializer emitted are repaired at read boundaries by ./heal.ts.

/** Reserved code-fence info string for a rendered-HTML block. `cleanLang` keeps
 *  the hyphen, so it round-trips, and it can't collide with a real language id. */
export const HTML_FENCE = "mh-html";

export const RE = {
  fenceOpen: /^\s*(`{3,}|~{3,})\s*([^\s`]*)?.*$/,
  h: /^(#{1,6})\s+(.*)$/,
  todo: /^\s*[-*+]\s+\[([ xX])\][ \t](.*)$/,
  bullet: /^\s*[-*+]\s+(.*)$/,
  numbered: /^\s*(\d+)[.)]\s+(.*)$/,
  quote: /^>[ \t](.*)$/,
  divider: /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/,
};

/** URL-scheme whitelist for rendered links/images — the single sanitizer every
 *  surface uses before emitting an `href`/`src` or calling `window.open`. Blocks
 *  the injection vectors (`javascript:`, `vbscript:`, and — for links — `data:`)
 *  while allowing normal web/mail/blob links, relative paths and `#anchors`.
 *  Returns "#" for anything rejected, so a hostile URL from synced or shared
 *  content can never execute. `allowData` is set for `<img>`, where `data:`
 *  image URIs are legitimate and non-executable. */
export function safeUrl(url: string, opts: { allowData?: boolean } = {}): string {
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url);
  if (!m) return url; // relative path, #anchor, or scheme-less — safe
  const scheme = m[1]!.toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "blob")
    return url;
  if (scheme === "data" && opts.allowData) return url;
  return "#";
}

// ---- media-embed grammar (shared by editor scan, save parser, share render) ----

/** A line that is solely a media/file embed is a block-level void on every
 *  surface. The classifier + its helpers live here so the same bytes are a block
 *  on all three (editor scan, `blocks.startsLeafBlock`, share renderer) — the
 *  divergence that let a media line fold into a paragraph on save only. */
export type MediaKind = "image" | "video" | "audio" | "file";

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "ogv", "mkv", "ogg"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "flac", "opus", "oga", "weba"]);

/** Lowercased file extension of a URL (no query/fragment), or "". */
export function extOf(url: string): string {
  const clean = url.split(/[?#]/, 1)[0] ?? url;
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Which `![](url)` embed a media URL is, by extension. Image syntax never maps
 *  to "file": an unknown extension written as `![]()` is treated as an image. */
export function imageSyntaxKind(ext: string): "image" | "video" | "audio" {
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "image";
}

/** Split a media URL into its base src and an optional `w=` width, preserving any
 *  other query params / fragment (external images may carry signed tokens). */
export function parseMediaUrl(url: string): { src: string; width?: number } {
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

export interface MediaLine {
  kind: MediaKind;
  src: string;
  name: string;
  width?: number; // image only
  size?: number; // file only
}

/** A line that is solely one embed → its classified parts, else null. Media use
 *  `![alt](url)` (kind by extension); a file uses a `[name](/blob/..)` link so a
 *  plain standalone hyperlink stays a paragraph. */
export function matchMediaEmbed(line: string): MediaLine | null {
  const t = line.trim();
  let m = t.match(/^!\[([^\]]*)\]\(([^\s)]+)\)$/);
  if (m) {
    const { src, width } = parseMediaUrl(m[2]!);
    const kind = imageSyntaxKind(extOf(src));
    const r: MediaLine = { kind, src, name: m[1]! };
    if (kind === "image" && width) r.width = width;
    return r;
  }
  m = t.match(/^\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)$/);
  if (m && m[2]!.startsWith("/blob/")) {
    const r: MediaLine = { kind: "file", src: m[2]!, name: m[1]! };
    if (m[3] != null && /^\d+$/.test(m[3])) r.size = parseInt(m[3], 10);
    return r;
  }
  return null;
}

/** The single quote-line predicate for all consumers: quote content of `text`
 *  ("" for the serializer's empty form `> `), or null if the line is not a
 *  quote line. `text` must already be indent-stripped. */
export function matchQuoteLine(text: string): string | null {
  const m = text.match(RE.quote);
  return m ? m[1]! : null;
}

export interface ListLine {
  indent: number;
  type: "bullet" | "numbered" | "todo";
  checked?: boolean;
  content: string;
  num?: number; // numbered only: the literal number the user wrote
}

export function matchListLine(line: string, minIndent: number): ListLine | null {
  const indent = leadingIndent(line);
  if (indent < minIndent) return null;
  const text = stripIndent(line, indent);

  // STRICT like RE.todo: whitespace after `]` required — `- [ ] x` / `- [ ] `
  // are todos, a bare `- [ ]` (mid-typing) is a bullet whose content is `[ ]`.
  let m = text.match(/^[-*+]\s+\[([ xX])\][ \t](.*)$/);
  if (m) {
    return {
      indent,
      type: "todo",
      checked: m[1]!.toLowerCase() === "x",
      content: m[2]!,
    };
  }

  // STRICT: the marker needs trailing whitespace to be a list item. An empty
  // item serializes as `- ` / `2. ` (marker + trailing space, empty content) and
  // parses back as one — core's parseDocBlocks keeps line content verbatim, so
  // the trailing space survives sync. A BARE `-` / `2.` (no space, the state
  // mid-typing before the space) is a paragraph, `-foo`/`2.foo` are paragraphs,
  // `---` is a divider. This is the same rule the CM6 render uses, so what you
  // see while typing is exactly what a save/reload/share produces.
  m = text.match(/^(\d+)[.)][ \t]+(.*)$/);
  if (m) return { indent, type: "numbered", content: m[2]!, num: parseInt(m[1]!, 10) };

  m = text.match(/^[-*+][ \t]+(.*)$/);
  if (m) return { indent, type: "bullet", content: m[1]! };

  return null;
}

/** Leading indentation of `line` in COLUMNS (tab = 4). */
export function leadingIndent(line: string): number {
  let indent = 0;
  for (const ch of line) {
    if (ch === " ") indent++;
    else if (ch === "\t") indent += 4;
    else break;
  }
  return indent;
}

/** Drop up to `columns` columns of leading whitespace from `line` (tab = 4). */
export function stripIndent(line: string, columns: number): string {
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

/** True when `line` closes a fence opened with `len` × `char` (same character,
 *  at least the same length, nothing else on the line). */
export function isFenceClose(line: string, char: string, len: number): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== char) return false;
  for (const ch of trimmed) {
    if (ch !== char) return false;
  }
  return trimmed.length >= len;
}

export function cleanLang(lang: string): string {
  return lang.trim().replace(/[^A-Za-z0-9_+.#-]/g, "");
}

// ---- GFM pipe tables ----
export const RE_DELIM_CELL = /^\s*:?-+:?\s*$/;

/** True if a GFM table begins at line `i`: a pipe row immediately followed by a
 *  delimiter row (e.g. `| :--- | ---: |`). */
export function looksLikeTableAt(lines: string[], i: number, minIndent: number): boolean {
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
export function splitTableRow(line: string): string[] {
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
