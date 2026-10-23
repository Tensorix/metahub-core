// Auth-aware transport shared by SDK CRUD, history, and the live stream.
// A session owns token persistence and invalid-credential recovery.

import type {
  RecordRevision,
  RecordVersionState,
  RevertRecordResult,
} from "../../../../../src/core/history.ts";

import { createAuthTransport } from "../auth/transport";
import type { Credentials } from "../auth/credentials";
import { MetahubError } from "./sdk";

export type { RecordRevision, RecordVersionState, RevertRecordResult };

const q = encodeURIComponent;

export interface MobileApi {
  fetch(
    path: string,
    init?: RequestInit,
    transport?: (url: string, init?: RequestInit) => Promise<Response>,
  ): Promise<Response>;
  fetchUrl(url: string, init?: RequestInit): Promise<Response>;
  dispose(): void;
  req<T>(method: string, path: string, body?: unknown): Promise<T>;
  readonly baseUrl: string;
  readonly token: string;
  readonly authInvalid: boolean;
  health(): Promise<{ ok: boolean; node?: string; version?: string }>;
  version(): Promise<{ version: string }>;
  renew(): Promise<void>;
  // History endpoints the public SDK deliberately omits.
  recordHistory(id: string): Promise<RecordRevision[]>;
  recordAt(id: string, version: string): Promise<RecordVersionState>;
  revertRecord(id: string, to: string): Promise<RevertRecordResult>;
}

export function createMobileApi(
  creds: Credentials,
  onToken?: (token: string) => void,
  onInvalid?: () => void,
): MobileApi {
  const base = creds.baseUrl.replace(/\/$/, "");
  const auth = createAuthTransport(base, creds.token, { onToken, onInvalid });
  const authFetch: MobileApi["fetch"] = (path, init, transport) =>
    auth.fetchUrl(base + path, init, transport);

  const req = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    const res = await authFetch(path, init);
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as {
        error?: string;
        code?: string;
      } | null;
      throw new MetahubError(
        d?.error ?? `HTTP ${res.status}`,
        d?.code,
        res.status,
      );
    }
    return (await res.json()) as T;
  };

  return {
    fetch: authFetch,
    fetchUrl: auth.fetchUrl,
    dispose: auth.dispose,
    req,
    baseUrl: base,
    get authInvalid() {
      return auth.invalid;
    },
    get token() {
      return auth.token;
    },
    health: () => req("GET", "/health"),
    version: () => req("GET", "/api/version"),
    recordHistory: (id) => req("GET", `/api/record/history?id=${q(id)}`),
    recordAt: (id, version) =>
      req("GET", `/api/record/at?id=${q(id)}&version=${q(version)}`),
    revertRecord: (id, to) =>
      req("POST", `/api/record/revert?id=${q(id)}`, { to }),
    renew: auth.renew,
  };
}

/** Verify a server + token pair before persisting it (onboarding).
 *  /health is auth-exempt (reachability); /api/version requires auth. */
export async function verifyServer(
  baseUrl: string,
  token: string,
): Promise<
  { ok: true; version: string } | { ok: false; reason: "unreachable" | "auth" }
> {
  const base = baseUrl.replace(/\/$/, "");
  let health: Response;
  try {
    health = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!health.ok) return { ok: false, reason: "unreachable" };
  const ver = await fetch(`${base}/api/version`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!ver || (ver.status !== 401 && ver.status !== 403 && !ver.ok))
    return { ok: false, reason: "unreachable" };
  if (!ver.ok) return { ok: false, reason: "auth" };
  const d = (await ver.json().catch(() => null)) as { version?: string } | null;
  return { ok: true, version: d?.version ?? "?" };
}
