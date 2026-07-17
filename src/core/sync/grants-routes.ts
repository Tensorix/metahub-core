// The granted (guest) data API — the narrow, grant-scoped mirror of the main
// /api surface, mounted at /sites/<name>/api/* (public principal) and
// /share/<slug>/api/* (share principal). One implementation for both mounts.
//
// PORTABLE by design: pure (Request → Response) shape, driver-only imports, no
// Bun/node APIs — a future Durable Object room reuses this exact module for its
// guest read/write face. Host concerns (rate limiting, client IP, principal
// derivation) are injected through GrantedApiDeps.
//
// Surface (deliberately tiny — no DELETE, no database enumeration):
//   GET   records?db=&sort=&limit=   (read)   limit clamps to 500, defaults 100
//   GET   record?id=                 (read)
//   GET   properties?db=             (read)
//   POST  records?db=                (create)
//   PATCH record?id=                 (update)
// Response shapes match the main API byte-for-byte (the SDK needs no changes).
// Authorization failures are a uniform 401 (anti-enumeration, grants-core).

import type { DbDriver } from "../driver.ts";
import { MhError, errorCode, type MhErrorCode } from "../errors.ts";
import { listProperties } from "../properties.ts";
import { listRecords } from "../records.ts";
import {
  type GrantSet,
  type GrantPrincipal,
  GUEST_LIMITS,
  authorizeDbRef,
  authorizeRecord,
  guestCreateRecord,
  guestUpdateRecord,
} from "../grants-core.ts";

export interface GrantedApiDeps {
  db: DbDriver;
  set: GrantSet;
  principal: GrantPrincipal;
  /** Host-injected rate limit: return false to answer 429. Called once per
   *  request with its class ("read" for GETs, "write" for mutations). */
  allow: (cls: "read" | "write") => boolean;
  /** Optional async gate run before a write (POST/PATCH) is accepted, after the
   *  rate limit and before the body is read — the anti-abuse (Turnstile /
   *  password) check on the public site mount. Throws MhError to reject. */
  beforeWrite?: () => Promise<void>;
}

const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 500;

// Local status map (grants-routes must not import routes.ts — that would drag
// the whole node-only route registry into the portable bundle).
const STATUS: Partial<Record<MhErrorCode, number>> = {
  invalid_input: 400,
  not_found: 404,
  ambiguous: 400,
  stale: 409,
  conflict: 409,
  auth: 401,
  rate_limited: 429,
};

function errJson(e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e);
  const code = errorCode(e);
  return Response.json(code ? { error: message, code } : { error: message }, {
    status: code ? (STATUS[code] ?? 400) : 400,
  });
}

function tooMany(): Response {
  return Response.json(
    { error: "too many requests — slow down", code: "rate_limited" },
    { status: 429 },
  );
}

function needParam(url: URL, key: string): string {
  const v = url.searchParams.get(key);
  if (!v) throw new MhError("invalid_input", `missing query param: ${key}`);
  return v;
}

/** Read a JSON body with the guest body-size cap enforced BEFORE parsing. */
async function guestJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > GUEST_LIMITS.maxBodyBytes)
    throw new MhError("invalid_input", `payload too large (max ${GUEST_LIMITS.maxBodyBytes} bytes)`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    throw new MhError("invalid_input", "body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new MhError("invalid_input", "body must be a JSON object of {column: value}");
  return parsed as Record<string, unknown>;
}

/**
 * Serve one granted-API request. `sub` is the path under the api/ mount
 * (e.g. "records", "record", "properties"); query params ride on req.url.
 * Never throws — every outcome is a Response.
 */
export async function serveGrantedApi(
  req: Request,
  sub: string,
  deps: GrantedApiDeps,
): Promise<Response> {
  const { db, set, principal } = deps;
  const url = new URL(req.url);
  try {
    if (req.method === "GET") {
      if (!deps.allow("read")) return tooMany();
      if (sub === "records") {
        const dbRow = authorizeDbRef(db, set, needParam(url, "db"), "read");
        const rawLimit = Number(url.searchParams.get("limit") ?? NaN);
        const limit = Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(Math.floor(rawLimit), LIST_LIMIT_MAX))
          : LIST_LIMIT_DEFAULT;
        const sort = url.searchParams.get("sort") ?? undefined;
        return Response.json(listRecords(db, dbRow.id, { sort, limit }));
      }
      if (sub === "record") {
        return Response.json(authorizeRecord(db, set, needParam(url, "id"), "read"));
      }
      if (sub === "properties") {
        const dbRow = authorizeDbRef(db, set, needParam(url, "db"), "read");
        return Response.json(listProperties(db, dbRow.id));
      }
    }
    if (req.method === "POST" && sub === "records") {
      if (!deps.allow("write")) return tooMany();
      if (deps.beforeWrite) await deps.beforeWrite();
      const values = await guestJsonBody(req);
      return Response.json(
        guestCreateRecord(db, set, principal, needParam(url, "db"), values),
      );
    }
    if (req.method === "PATCH" && sub === "record") {
      if (!deps.allow("write")) return tooMany();
      if (deps.beforeWrite) await deps.beforeWrite();
      const values = await guestJsonBody(req);
      return Response.json(
        guestUpdateRecord(db, set, principal, needParam(url, "id"), values),
      );
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return errJson(e);
  }
}
