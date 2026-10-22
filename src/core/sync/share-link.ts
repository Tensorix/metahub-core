// Wire format shared by the data-blind short-link API, owner and viewer.
// Neither request nor response ever contains a content key or bucket credential.
import { fromB64, toB64url } from "./e2ee.ts";

export const SHARE_LINK_ID = /^[A-Za-z0-9_-]{22}$/;
export const SHARE_LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const SHARE_LINK_MAX_BODY = 12_288;
export interface ShareLinkDescriptor {
  v: 1;
  manifestUrl: string;
  expiresAt: number;
  salt?: string;
}

export async function tokenHash(token: string): Promise<string> {
  return toB64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  );
}

export async function linkId(token: string): Promise<string> {
  // Bind an ID to its management capability even after a record is purged.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return toB64url(new Uint8Array(digest).slice(0, 16));
}

export function decodeLinkKey(value: string): Uint8Array {
  return fromB64(value.replace(/-/g, "+").replace(/_/g, "/"));
}

/** Exact expiry encoded by our S3 SigV4 signer, not upload completion time. */
export function signedUrlExpiry(value: string): number | null {
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.hash ||
      value.length > 8192
    )
      return null;
    const date = u.searchParams.get("X-Amz-Date") ?? "";
    const seconds = Number(u.searchParams.get("X-Amz-Expires"));
    if (
      !/^\d{8}T\d{6}Z$/.test(date) ||
      !Number.isInteger(seconds) ||
      seconds < 1 ||
      seconds > 604800
    )
      return null;
    if (!/^[a-f0-9]{64}$/i.test(u.searchParams.get("X-Amz-Signature") ?? ""))
      return null;
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`;
    const start = Date.parse(iso);
    return Number.isFinite(start) ? start + seconds * 1000 : null;
  } catch {
    return null;
  }
}

export function validDescriptor(value: unknown): value is ShareLinkDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  if (
    Object.keys(d).some(
      (k) => !["v", "manifestUrl", "expiresAt", "salt"].includes(k),
    )
  )
    return false;
  if (
    d.v !== 1 ||
    typeof d.manifestUrl !== "string" ||
    !Number.isSafeInteger(d.expiresAt)
  )
    return false;
  const expiry = signedUrlExpiry(d.manifestUrl);
  if (expiry === null || (d.expiresAt as number) > expiry) return false;
  if (d.salt !== undefined) {
    if (typeof d.salt !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(d.salt))
      return false;
  }
  return true;
}

/** Preserve raw '+' in old base64 fragments; URLSearchParams would corrupt it. */
export function parseShareFragment(hash: string): {
  m?: string;
  k?: string;
  s?: string;
} {
  const parts: Record<string, string> = Object.create(null);
  for (const part of hash.replace(/^#/, "").split("&")) {
    const i = part.indexOf("=");
    if (i >= 0) parts[part.slice(0, i)] = part.slice(i + 1);
  }
  return {
    m: parts.m ? decodeURIComponent(parts.m) : undefined,
    k: parts.k,
    s: parts.s,
  };
}

export function longShareUrl(
  base: string,
  link: { manifestUrl: string; keyB64?: string; saltB64?: string },
): string {
  return `${base.replace(/\/+$/, "")}/#m=${encodeURIComponent(link.manifestUrl)}&${link.keyB64 ? `k=${link.keyB64}` : `s=${link.saltB64}`}`;
}
