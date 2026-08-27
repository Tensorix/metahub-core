import * as SecureStore from "expo-secure-store";

const URL_KEY = "mh.server.url";
const TOKEN_KEY = "mh.server.token";

export interface Credentials {
  baseUrl: string;
  token: string;
}

export async function loadCredentials(): Promise<Credentials | null> {
  const [baseUrl, token] = await Promise.all([
    SecureStore.getItemAsync(URL_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

export async function saveCredentials(c: Credentials): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(URL_KEY, c.baseUrl),
    SecureStore.setItemAsync(TOKEN_KEY, c.token),
  ]);
}

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearCredentials(): Promise<void> {
  await Promise.all([
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
    // Origin only — the server's routes are exact-match from /.
    return u.origin;
  } catch {
    return null;
  }
}

export type QrParse =
  | { kind: "server"; baseUrl: string; token: string }
  | { kind: "enroll" }
  | { kind: "unknown" };

/** Classify a scanned QR payload. The WebUI/desktop "open on your phone" QR is
 *  `<server>/?token=<tok>`; the desktop's bucket QR is `…#enroll=<code>` which
 *  a thin HTTP client cannot use — reject it with guidance instead of failing
 *  mysteriously. */
export function parseQrPayload(data: string): QrParse {
  const s = data.trim();
  if (/#enroll=/.test(s) || /^enroll=/.test(s)) return { kind: "enroll" };
  try {
    const u = new URL(s);
    const token = u.searchParams.get("token");
    if ((u.protocol === "http:" || u.protocol === "https:") && token)
      return { kind: "server", baseUrl: u.origin, token };
  } catch {
    /* not a URL */
  }
  return { kind: "unknown" };
}
