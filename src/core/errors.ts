/**
 * Machine-readable error taxonomy — the contract between core and its callers.
 *
 * Agents and scripts dispatch on `code`, never on message text (messages may
 * be reworded freely). The CLI maps codes to exit codes (src/cli/output.ts)
 * and the HTTP layer maps them to status codes (src/webui/server/routes.ts),
 * so adding a code here is enough for both surfaces to pick it up.
 */
export type MhErrorCode =
  /** Bad arguments / refusing a request as stated (HTTP 400, exit 2). */
  | "invalid_input"
  /** Referenced entity does not exist (HTTP 404, exit 3). */
  | "not_found"
  /** A ref matched more than one entity — disambiguate and retry (exit 4). */
  | "ambiguous"
  /** Optimistic-concurrency failure: re-read, then retry (HTTP 409, exit 5). */
  | "stale"
  /** State conflict, e.g. a name that already exists (HTTP 409, exit 5). */
  | "conflict"
  /** Missing/invalid credentials (HTTP 401, exit 6). */
  | "auth"
  /** A remote peer was unreachable or replied non-OK — retryable (exit 7). */
  | "network"
  /** Too many requests in the window — retry later (HTTP 429, exit 8). */
  | "rate_limited"
  /** Another process holds the write lock; nothing was written — retry the
   *  same call after a short backoff (HTTP 503, exit 9). */
  | "busy"
  /** A clock is more than HLC_MAX_SKEW_MS ahead of wall time; writes refuse
   *  until `mh repair --clock` (HTTP 409, exit 10). */
  | "clock_skew"
  /** The requested listen port is taken (exit 98, historical). */
  | "port_in_use";

export type MsgParams = Record<string, string | number>;

export class MhError extends Error {
  constructor(
    readonly code: MhErrorCode,
    message: string,
    readonly i18n?: { key: string; params?: MsgParams },
  ) {
    super(message);
    this.name = "MhError";
  }
}

export function interpolateMsg(s: string, params?: MsgParams): string {
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;
}

export function mhError(code: MhErrorCode, key: string, params?: MsgParams): MhError {
  return new MhError(code, interpolateMsg(key, params), { key, params });
}

const SQLITE_BUSY_RE = /^SQLITE_(BUSY|LOCKED)/;

function isSqliteBusy(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && SQLITE_BUSY_RE.test(code)) return true;
  return e.message === "database is locked";
}

/** Normalize a thrown value to an MhError when it maps to one of our codes. */
export function asMhError(e: unknown): MhError | null {
  if (e instanceof MhError) return e;
  if (isSqliteBusy(e)) return mhError("busy", "数据库正被另一个进程写入，请稍后重试");
  return null;
}

/** The error's code, for errors that carry one (anything else → undefined). */
export function errorCode(e: unknown): MhErrorCode | undefined {
  return asMhError(e)?.code;
}
