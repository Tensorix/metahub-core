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
  /** The requested listen port is taken (exit 98, historical). */
  | "port_in_use";

export class MhError extends Error {
  constructor(
    readonly code: MhErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MhError";
  }
}

/** The error's code, for errors that carry one (anything else → undefined). */
export function errorCode(e: unknown): MhErrorCode | undefined {
  return e instanceof MhError ? e.code : undefined;
}
