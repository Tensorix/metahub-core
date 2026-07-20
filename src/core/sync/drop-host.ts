// Owner-side client for a write-inbox host (the edge worker's /v1/inbox API,
// or any protocol-compatible host connected via `mh edge connect`). Host-
// agnostic by construction: everything goes through the DropHostApi interface,
// and tests run the same client against the edge worker's handler in memory.

import { MhError, type MhErrorCode } from "../errors.ts";

export interface DropRegistration {
  turnstile_sitekey?: string | null;
  turnstile_secret?: string | null;
  password_salt?: string | null;
  password_verifier?: string | null;
  max_envelopes?: number;
  max_bytes?: number;
}

export interface DropEnvelopeRow {
  /** Host-side monotonically increasing row id — the pull/ack cursor. */
  id: number;
  /** The stored envelope JSON (validated by drop-protocol on the owner side). */
  envelope: unknown;
}

export interface DropStats {
  drop_id: string;
  envelopes: number;
  bytes: number;
  max_envelopes: number;
  max_bytes: number;
}

export interface DropHostApi {
  register(dropId: string, reg: DropRegistration): Promise<void>;
  unregister(dropId: string): Promise<boolean>;
  listEnvelopes(dropId: string, afterId: number, limit: number): Promise<DropEnvelopeRow[]>;
  ackEnvelopes(dropId: string, ids: number[]): Promise<number>;
  stats(dropId: string): Promise<DropStats>;
  health(): Promise<{ ok: boolean; version?: string }>;
  ownerHealth(): Promise<{ ok: boolean; version?: string }>;
}

function statusCode(status: number): MhErrorCode {
  if (status === 401) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "network";
}

/** HTTP implementation against an inbox host base URL + drt_ owner secret.
 *  `fetcher` is injectable so tests drive the edge worker handler in-process. */
export function httpDropHost(
  endpoint: string,
  token: string,
  fetcher: typeof fetch = fetch,
): DropHostApi {
  const base = endpoint.replace(/\/+$/, "");

  async function call<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
    let res: Response;
    try {
      res = await fetcher(base + path, {
        ...init,
        headers: {
          ...(init.body != null ? { "content-type": "application/json" } : {}),
          ...(auth ? { authorization: `Bearer ${token}` } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (e) {
      throw new MhError("network", `inbox host unreachable: ${(e as Error).message}`);
    }
    const data = (await res.json().catch(() => null)) as ({ error?: string } & T) | null;
    if (!res.ok)
      throw new MhError(statusCode(res.status), `inbox host: ${data?.error ?? `HTTP ${res.status}`}`);
    return data as T;
  }

  const drop = (id: string) => `/v1/inbox/${encodeURIComponent(id)}`;

  return {
    async register(dropId, reg) {
      await call(drop(dropId), { method: "PUT", body: JSON.stringify(reg) });
    },
    async unregister(dropId) {
      const r = await call<{ deleted: boolean }>(drop(dropId), { method: "DELETE" });
      return r.deleted;
    },
    async listEnvelopes(dropId, afterId, limit) {
      const r = await call<{ rows: DropEnvelopeRow[] }>(
        `${drop(dropId)}/envelopes?after_id=${afterId}&limit=${limit}`,
      );
      return r.rows;
    },
    async ackEnvelopes(dropId, ids) {
      if (ids.length === 0) return 0;
      const r = await call<{ deleted: number }>(`${drop(dropId)}/envelopes`, {
        method: "DELETE",
        body: JSON.stringify({ ids }),
      });
      return r.deleted;
    },
    async stats(dropId) {
      return call<DropStats>(`${drop(dropId)}/stats`);
    },
    async health() {
      return call<{ ok: boolean; version?: string }>("/health", {}, false);
    },
    async ownerHealth() {
      return call<{ ok: boolean; version?: string }>("/owner/health");
    },
  };
}
