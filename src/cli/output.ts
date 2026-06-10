import { errorCode, type MhErrorCode } from "../core/errors.ts";

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

/**
 * Exit code per error code — the CLI's contract with scripts/agents (also
 * documented in SKILL.md). Dispatch on these (or on the JSON `code` field),
 * never on message text. 1 = uncategorized failure.
 */
const EXIT_CODES: Record<MhErrorCode, number> = {
  invalid_input: 2,
  not_found: 3,
  ambiguous: 4,
  stale: 5,
  conflict: 5,
  auth: 6,
  network: 7,
  port_in_use: 98, // historical: pre-dates the code taxonomy
};

/** Print an error and exit non-zero. `codeOrExit`: an MhErrorCode (mapped via
 *  EXIT_CODES, emitted as the JSON `code` field) or a raw exit number. */
export function fail(message: string, codeOrExit: MhErrorCode | number = 1): never {
  const code = typeof codeOrExit === "string" ? codeOrExit : undefined;
  const exit = typeof codeOrExit === "string" ? EXIT_CODES[codeOrExit] : codeOrExit;
  if (wantJson()) console.log(JSON.stringify(code ? { error: message, code } : { error: message }));
  else console.error(`error: ${message}`);
  process.exit(exit);
}

/** Wrap a citty run body so thrown errors become clean `{error, code?}` +
 *  a semantic exit code (see EXIT_CODES; uncategorized errors exit 1). */
export function guard(
  fn: (args: Record<string, any>) => unknown | Promise<unknown>,
): (ctx: { args: Record<string, any> }) => Promise<void> {
  return async (ctx) => {
    try {
      await fn(ctx.args);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), errorCode(e) ?? 1);
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
