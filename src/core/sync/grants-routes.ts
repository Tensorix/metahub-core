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
import { MhError } from "../errors.ts";
import { errorBody } from "./http-status.ts";
import { listProperties } from "../properties.ts";
import { listRecords } from "../records.ts";
import {
  type GrantSet,
  type GrantPrincipal,
  GUEST_LIMITS,
  authorizeDbRef,
  authorizeRecord,
} from "../grants-core.ts";
import type { AccessPolicy } from "../access-policy.ts";
import { applyGuestIntent, type GuestIntent } from "../guest-intent.ts";
import { randomSuffix } from "../ids.ts";
import { assertAntiAbuse, type VerifyTurnstile } from "./anti-abuse.ts";

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

/**
 * Build GrantedApiDeps from a resolved AccessPolicy — the one place a mount
 * turns "who may do what" into the serving deps, so the grants + write-gate
 * wiring is identical across the site / share / room adapters (the drift that
 * once let a --password grant be enforced on one transport and skipped on
 * another). `beforeWrite` is synthesized from policy.writeGate via the shared
 * assertAntiAbuse.
 *
 * The gate is per-write ONLY for the public audience: a public site has no
 * session, so the SDK sends the password/Turnstile proof (x-drop-pass /
 * x-turnstile-token) on every write and this gate verifies it — the SAME gate
 * the write-inbox enforces. Share/room audiences spend their password once at
 * unlock and carry a session cookie thereafter, so their writeGate is an
 * unlock-time gate, not a per-write one → no beforeWrite here.
 */
export function grantedDepsFromPolicy(
  policy: AccessPolicy,
  host: {
    db: DbDriver;
    principal: GrantPrincipal;
    allow: (cls: "read" | "write") => boolean;
    req: Request;
    ip?: string | null;
    verifyTurnstile?: VerifyTurnstile;
  },
): GrantedApiDeps {
  const gate = policy.writeGate;
  const gated = policy.audience === "public" && !!(gate.turnstile?.secret || gate.password);
  return {
    db: host.db,
    set: policy.grants,
    principal: host.principal,
    allow: host.allow,
    beforeWrite: gated
      ? () =>
          assertAntiAbuse(
            { turnstileSecret: gate.turnstile?.secret, passwordVerifier: gate.password?.verifierB64 },
            host.req,
            { verifyTurnstile: host.verifyTurnstile, ip: host.ip ?? null },
          )
      : undefined,
  };
}

function errJson(e: unknown): Response {
  const { body, status } = errorBody(e);
  return Response.json(body, { status });
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

/** A guest write body is either the intent wrapper `{"$intent":{id,submittedAt},
 *  "values":{…}}` (new SDK — carries a client idempotency key) or a plain
 *  `{column: value}` object (legacy / hand-rolled — server mints the intentId).
 *  Both forever supported. A column literally named "$intent" can't collide: it
 *  isn't a property id/name, so resolveData would reject it anyway. */
function readWriteBody(body: Record<string, unknown>): {
  intentId: string;
  submittedAt: number;
  values: Record<string, unknown>;
} {
  const wrap = body["$intent"];
  if (wrap && typeof wrap === "object" && !Array.isArray(wrap) && "values" in body) {
    const meta = wrap as { id?: unknown; submittedAt?: unknown };
    const values = body["values"];
    if (typeof values !== "object" || values === null || Array.isArray(values))
      throw new MhError("invalid_input", "intent values must be a JSON object");
    if (typeof meta.id !== "string")
      throw new MhError("invalid_input", "intent id must be a string");
    return {
      intentId: meta.id,
      submittedAt: Number.isFinite(meta.submittedAt) ? (meta.submittedAt as number) : Date.now(),
      values: values as Record<string, unknown>,
    };
  }
  return { intentId: "srv_" + randomSuffix(16), submittedAt: Date.now(), values: body };
}

/** A thin authority-clock policy over the deps' grant set — the guest surface
 *  authorizes by (set, principal); expiry/session gating already ran upstream. */
function authorityPolicy(deps: GrantedApiDeps): AccessPolicy {
  return {
    audience: deps.principal.kind,
    grants: deps.set,
    writeGate: {},
    limits: GUEST_LIMITS,
    revision: 0,
    expiresAt: null,
    guestBase: deps.principal.guestNode,
  };
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
      const { intentId, submittedAt, values } = readWriteBody(await guestJsonBody(req));
      const intent: GuestIntent = {
        intentId,
        action: "createRecord",
        table: needParam(url, "db"),
        payload: values,
        submittedAt,
      };
      return Response.json(
        applyGuestIntent(db, authorityPolicy(deps), { guestNode: principal.guestNode }, intent, {
          clock: "authority",
        }),
      );
    }
    if (req.method === "PATCH" && sub === "record") {
      if (!deps.allow("write")) return tooMany();
      if (deps.beforeWrite) await deps.beforeWrite();
      const { intentId, submittedAt, values } = readWriteBody(await guestJsonBody(req));
      const intent: GuestIntent = {
        intentId,
        action: "updateRecord",
        recordId: needParam(url, "id"),
        payload: values,
        submittedAt,
      };
      return Response.json(
        applyGuestIntent(db, authorityPolicy(deps), { guestNode: principal.guestNode }, intent, {
          clock: "authority",
        }),
      );
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return errJson(e);
  }
}
