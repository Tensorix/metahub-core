import * as SecureStore from "expo-secure-store";
import type { S3Config } from "../../../../../src/core/sync/storage.ts";

const URL_KEY = "mh.server.url";
const TOKEN_KEY = "mh.server.token";
const SERVERS_KEY = "mh.servers";
const ACTIVE_KEY = "mh.active.workspace.v2";

export interface Credentials {
  baseUrl: string;
  token: string;
  bucket?: S3Config;
}

/** All servers this device has connected to (the active one included).
 *  Falls back to the active credentials for installs that predate the list. */
export async function listServers(): Promise<Credentials[]> {
  const raw = await SecureStore.getItemAsync(SERVERS_KEY);
  if (raw) {
    try {
      const arr = JSON.parse(raw) as Credentials[];
      if (Array.isArray(arr))
        return arr.filter(
          (s) =>
            s &&
            typeof s.baseUrl === "string" &&
            typeof s.token === "string" &&
            (s.bucket
              ? s.baseUrl.startsWith("s3:") &&
                !!s.bucket.bucket &&
                !!s.bucket.endpoint
              : normalizeBaseUrl(s.baseUrl) === s.baseUrl && !!s.token.trim()),
        );
    } catch {
      /* corrupted list — rebuild from active creds below */
    }
  }
  const active = await loadCredentials();
  return active ? [active] : [];
}

async function saveServers(servers: Credentials[]): Promise<void> {
  await SecureStore.setItemAsync(SERVERS_KEY, JSON.stringify(servers));
}

export async function upsertServer(c: Credentials): Promise<void> {
  const servers = await listServers();
  const next = servers.filter((s) => s.baseUrl !== c.baseUrl);
  next.unshift(c);
  await saveServers(next);
}

/** Remove a server; returns the remaining list. */
export async function removeServer(baseUrl: string): Promise<Credentials[]> {
  const next = (await listServers()).filter((s) => s.baseUrl !== baseUrl);
  await saveServers(next);
  return next;
}

export async function loadCredentials(): Promise<Credentials | null> {
  const active = await SecureStore.getItemAsync(ACTIVE_KEY);
  if (active) {
    try {
      const value = JSON.parse(active) as Credentials;
      if (
        value.bucket &&
        value.baseUrl?.startsWith("s3:") &&
        value.bucket.bucket &&
        value.bucket.endpoint
      )
        return value;
      if (
        typeof value.token === "string" &&
        value.token.trim() &&
        normalizeBaseUrl(value.baseUrl) === value.baseUrl
      )
        return value;
    } catch {
      /* fall back to legacy credentials */
    }
  }
  const [baseUrl, token] = await Promise.all([
    SecureStore.getItemAsync(URL_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  if (!baseUrl || !token) return null;
  if (normalizeBaseUrl(baseUrl) !== baseUrl || !token.trim()) return null;
  return { baseUrl, token };
}

export async function saveCredentials(c: Credentials): Promise<void> {
  // A single atomic credential record prevents mixed URL/token after a crash.
  await SecureStore.setItemAsync(ACTIVE_KEY, JSON.stringify(c));
}

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearCredentials(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACTIVE_KEY),
    SecureStore.deleteItemAsync(URL_KEY),
    SecureStore.deleteItemAsync(TOKEN_KEY),
  ]);
}

/** Normalize a user-typed server address to an origin. */
export function normalizeBaseUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    // Origin only — the server's routes are exact-match from /.
    return u.origin;
  } catch {
    return null;
  }
}

export { parseQrPayload, type QrParse } from "./qr-payload";
