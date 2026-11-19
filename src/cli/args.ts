import { MhError } from "../core/errors.ts";

export type IntArgOpts = {
  /** Inclusive lower bound (default 0). */
  min?: number;
  /** Inclusive upper bound. */
  max?: number;
};

/**
 * Parse a CLI number flag into a finite integer, or return undefined when the
 * flag was omitted. Throws `invalid_input` (exit 2) for blank / non-integer /
 * out-of-range values so agents never see a raw SQLite datatype mismatch.
 */
export function parseIntArg(
  raw: string | undefined | null,
  flag: string,
  opts: IntArgOpts = {},
): number | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (s === "") throw new MhError("invalid_input", `${flag} requires an integer`);
  if (!/^-?\d+$/.test(s)) throw new MhError("invalid_input", `${flag} must be an integer (got ${JSON.stringify(raw)})`);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new MhError("invalid_input", `${flag} is out of range`);
  const min = opts.min ?? 0;
  if (n < min) throw new MhError("invalid_input", `${flag} must be >= ${min}`);
  if (opts.max != null && n > opts.max) throw new MhError("invalid_input", `${flag} must be <= ${opts.max}`);
  return n;
}

/** Split a comma-separated flag into trimmed non-empty tokens. */
export function parseCommaList(raw: string | undefined | null, flag: string): string[] {
  if (raw == null) return [];
  const parts = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new MhError("invalid_input", `${flag} requires at least one name`);
  return parts;
}
