// The 格式化 dispatcher the code block calls: routes a fence language to its
// engine (lang-map.ts) — native JSON and bracket reindent run inline and
// synchronously; everything else lazy-loads its provider bundle (load.ts).
// Post-processing is centralized here: trailing-newline normalization (block
// content carries no trailing \n — see blocks.ts serialization), cursor
// clamping, and the unchanged→null contract that keeps no-op formats out of
// the CM undo history.

import { langEngine, type ProviderEngine } from "./lang-map.ts";
import { loadProvider } from "./load.ts";
import { reindent } from "./reindent.ts";

export interface FmtResult {
  text: string;
  cursor: number;
}

/**
 * Strip trailing commas (`,` directly before `}` / `]`, whitespace allowed)
 * outside strings — the one hand-written-JSON blemish worth tolerating before
 * the strict native parse. Anything else stays a loud parse error.
 */
export function stripTrailingCommas(src: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") { out += src[i + 1] ?? ""; i++; }
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j]!)) j++;
      if (src[j] === "}" || src[j] === "]") continue; // drop the trailing comma
    }
    out += ch;
  }
  return out;
}

/** Native full-fidelity JSON formatting — instant, no engine download. */
export function formatJson(code: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingCommas(code));
  } catch (e) {
    throw new Error(`JSON 解析失败:${(e as Error).message}`);
  }
  return JSON.stringify(parsed, null, 2);
}

/**
 * Cursor re-mapping for line-preserving rewrites (reindent): same line, same
 * column within the content after the leading whitespace. Falls back to a
 * plain clamp when the line counts diverge (JSON / real formatters).
 */
export function mapCursor(oldText: string, newText: string, cursor: number): number {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  if (oldLines.length !== newLines.length) return Math.min(cursor, newText.length);
  let line = 0;
  let lineStart = 0;
  for (let pos = 0; line < oldLines.length - 1; line++) {
    const next = pos + oldLines[line]!.length + 1;
    if (cursor < next) break;
    pos = next;
    lineStart = next;
  }
  const oldLine = oldLines[line]!;
  const newLine = newLines[line]!;
  const oldWs = /^[ \t]*/.exec(oldLine)![0]!.length;
  const newWs = /^[ \t]*/.exec(newLine)![0]!.length;
  const col = Math.max(0, cursor - lineStart - oldWs);
  let newLineStart = 0;
  for (let l = 0; l < line; l++) newLineStart += newLines[l]!.length + 1;
  return newLineStart + Math.min(newWs + col, newLine.length);
}

/**
 * Format a code block's content. Returns null when nothing would change (or
 * the language has no engine); throws with a user-facing message on syntax
 * errors and provider load failures — the caller flashes it, original text
 * untouched.
 */
export async function formatCode(
  code: string,
  lang: string | undefined,
  cursor: number,
): Promise<FmtResult | null> {
  const engine = langEngine(lang);
  if (!engine) return null;

  let text: string;
  let mapped: number | null = null;
  if (engine === "json") {
    text = formatJson(code);
  } else if (engine === "reindent") {
    const r = reindent(code, lang);
    if (r == null) return null;
    text = r;
    mapped = mapCursor(code, r, cursor);
  } else {
    const mod = await loadProvider(engine as ProviderEngine);
    const r = await mod.format(code, lang!.trim().toLowerCase(), cursor);
    text = r.text;
    mapped = r.cursor;
  }

  // Block content has no trailing newline; engines usually emit one.
  if (!code.endsWith("\n")) text = text.replace(/\n$/, "");
  if (text === code) return null;
  const at = Math.max(0, Math.min(mapped ?? cursor, text.length));
  return { text, cursor: at };
}
