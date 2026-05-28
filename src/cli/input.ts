/** Resolve a CLI value: `@file` reads a file, `@-` reads stdin, else literal. */
export async function resolveValue(raw: string | undefined): Promise<string | undefined> {
  if (raw == null) return undefined;
  if (raw === "@-") return await Bun.stdin.text();
  if (raw.startsWith("@")) return await Bun.file(raw.slice(1)).text();
  return raw;
}

/** Resolve a value and parse it as JSON. */
export async function resolveJson<T = unknown>(raw: string | undefined): Promise<T | undefined> {
  const text = await resolveValue(raw);
  if (text == null) return undefined;
  return JSON.parse(text) as T;
}
