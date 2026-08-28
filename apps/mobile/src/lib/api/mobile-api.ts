// Auth-aware fetch + the endpoints the public SDK deliberately omits.
// The SDK (createClient) never renews an explicitly-passed token, so renewal
// lives here: on 401, swap the in-grace token via GET /auth/token, persist it,
// notify the session (which rebuilds the SDK client), and retry once.
// Mirrors src/webui/api.ts authFetch.

import type {
  RecordRevision,
  RecordVersionState,
  RevertRecordResult,
} from "../../../../../src/core/history.ts";

import { saveToken, type Credentials } from "../auth/credentials";
import { MetahubError } from "./sdk";

export type { RecordRevision, RecordVersionState, RevertRecordResult };

const q = encodeURIComponent;

export interface MobileApi {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  req<T>(method: string, path: string, body?: unknown): Promise<T>;
  readonly baseUrl: string;
  readonly token: string;
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
): MobileApi {
  const base = creds.baseUrl.replace(/\/$/, "");
  let token = creds.token;

  const exec = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(base + path, { ...init, headers });
  };

  const adoptToken = async (t: string) => {
    token = t;
    await saveToken(t);
    onToken?.(t);
  };

  /** On 401, an in-grace token swaps itself for the current one (seamless
   *  30-day rotation); a second 401 means the credential is truly dead. */
  const authFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    let res = await exec(path, init);
    if (res.status === 401) {
      const renewed = await exec("/auth/token").catch(() => null);
      const d = renewed?.ok
        ? ((await renewed.json().catch(() => null)) as { token?: string } | null)
        : null;
      if (d?.token) {
        await adoptToken(d.token);
        res = await exec(path, init);
      }
    }
    return res;
  };

  const req = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    const res = await authFetch(path, init);
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as
        | { error?: string; code?: string }
        | null;
      throw new MetahubError(d?.error ?? `HTTP ${res.status}`, d?.code, res.status);
    }
    return (await res.json()) as T;
  };

  return {
    fetch: authFetch,
    req,
    baseUrl: base,
    get token() {
      return token;
    },
    health: () => req("GET", "/health"),
    version: () => req("GET", "/api/version"),
    recordHistory: (id) => req("GET", `/api/record/history?id=${q(id)}`),
    recordAt: (id, version) =>
      req("GET", `/api/record/at?id=${q(id)}&version=${q(version)}`),
    revertRecord: (id, to) => req("POST", `/api/record/revert?id=${q(id)}`, { to }),
    // Proactive renewal on launch/foreground keeps the 30-day rotation
    // healthy even though data requests rarely see a 401.
    renew: async () => {
      const res = await exec("/auth/token").catch(() => null);
      const d = res?.ok
        ? ((await res.json().catch(() => null)) as { token?: string } | null)
        : null;
      if (d?.token && d.token !== token) await adoptToken(d.token);
    },
  };
}

/** Verify a server + token pair before persisting it (onboarding).
 *  /health is auth-exempt (reachability); /api/version requires auth. */
export async function verifyServer(
  baseUrl: string,
  token: string,
): Promise<{ ok: true; version: string } | { ok: false; reason: "unreachable" | "auth" }> {
  const base = baseUrl.replace(/\/$/, "");
  let health: Response;
  try {
    health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!health.ok) return { ok: false, reason: "unreachable" };
  const ver = await fetch(`${base}/api/version`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!ver?.ok) return { ok: false, reason: "auth" };
  const d = (await ver.json().catch(() => null)) as { version?: string } | null;
  return { ok: true, version: d?.version ?? "?" };
}
