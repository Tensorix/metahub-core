// The one MhErrorCode → HTTP status map for the guest serving surfaces. Both the
// portable granted API (grants-routes.ts) and the DO room adapter (room-serve.ts)
// map errors identically, so the same error can't answer with two different HTTP
// codes across the mounts. Portable (driver-only) — safe in the workerd bundle.

import { errorCode, type MhErrorCode } from "../errors.ts";

const STATUS: Partial<Record<MhErrorCode, number>> = {
  invalid_input: 400,
  not_found: 404,
  ambiguous: 400,
  stale: 409,
  conflict: 409,
  auth: 401,
  rate_limited: 429,
};

/** HTTP status for an MhError code (400 fallback for unknown/absent codes). */
export function httpStatusForCode(code: MhErrorCode | undefined): number {
  return code ? (STATUS[code] ?? 400) : 400;
}

/** The `{error, code?}` body + status for a thrown error — shared by the guest
 *  mounts. Callers pick their own Response constructor (Response.json vs a DO
 *  json() helper), so this returns the parts, not a Response. */
export function errorBody(e: unknown): { body: { error: string; code?: MhErrorCode }; status: number } {
  const message = e instanceof Error ? e.message : String(e);
  const code = errorCode(e);
  return { body: code ? { error: message, code } : { error: message }, status: httpStatusForCode(code) };
}
