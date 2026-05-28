function wantJson(): boolean {
  const argv = process.argv;
  if (argv.includes("--json")) return true;
  if (argv.includes("--pretty")) return false;
  return !process.stdout.isTTY;
}

/** Print a success result: JSON for machines/pipes, human-readable for a TTY. */
export function print(data: unknown, pretty?: () => string): void {
  if (wantJson()) {
    console.log(JSON.stringify(data));
  } else if (pretty) {
    console.log(pretty());
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

/** Print an error and exit non-zero. */
export function fail(message: string, code = 1): never {
  if (wantJson()) console.log(JSON.stringify({ error: message }));
  else console.error(`error: ${message}`);
  process.exit(code);
}

/** Wrap a citty run body so thrown errors become clean `{error}` + exit 1. */
export function guard(
  fn: (args: Record<string, any>) => unknown | Promise<unknown>,
): (ctx: { args: Record<string, any> }) => Promise<void> {
  return async (ctx) => {
    try {
      await fn(ctx.args);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  };
}

/** Render an array of flat objects as an aligned ASCII table. */
export function table<T extends object>(rows: readonly T[]): string {
  if (rows.length === 0) return "(empty)";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const get = (r: T, c: string) => {
    const v = (r as Record<string, unknown>)[c];
    return v == null ? "" : String(v);
  };
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => get(r, c).length)),
  );
  const line = (vals: string[]) =>
    vals.map((v, i) => v.padEnd(widths[i] ?? 0)).join("  ");
  const out = [line(cols), line(widths.map((w) => "-".repeat(w)))];
  for (const r of rows) out.push(line(cols.map((c) => get(r, c))));
  return out.join("\n");
}
