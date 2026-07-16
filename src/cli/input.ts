import { MhError } from "../core/errors.ts";

/** Resolve a CLI value: `@file` reads a file, `@-` reads stdin, else literal. */
export async function resolveValue(raw: string | undefined): Promise<string | undefined> {
  if (raw == null) return undefined;
  if (raw === "@-") return await Bun.stdin.text();
  if (raw.startsWith("@")) return await Bun.file(raw.slice(1)).text();
  return raw;
}

/** Resolve a value and parse it as JSON. A malformed payload is a bad CLI input,
 *  so it surfaces as `invalid_input` (exit 2) — not a raw SyntaxError (exit 1) —
 *  keeping the exit-code contract consistent with the shape validators. */
export async function resolveJson<T = unknown>(raw: string | undefined): Promise<T | undefined> {
  const text = await resolveValue(raw);
  if (text == null) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new MhError("invalid_input", `invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}
