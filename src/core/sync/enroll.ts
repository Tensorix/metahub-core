// Enroll codec: the compact "join this bucket" token a desktop/WebUI hands to
// another device. It carries the bucket's *access* settings (endpoint, bucket,
// credentials) but NEVER the passphrase or master key — the joining device types
// the passphrase. One source of truth so the WebUI QR (`#enroll=<token>`) and the
// CLI (`mh config peer add --s3 --enroll <token>`) speak the exact same bytes.
//
// Isomorphic: only btoa/atob + TextEncoder/TextDecoder, all present on Bun and in
// browsers (same constraint as e2ee.ts). The base64url here is byte-identical to
// the WebUI's previous `btoa(unescape(encodeURIComponent(json)))` scheme, so QR
// codes minted before this module still decode.

import { MhError } from "../errors.ts";

/** The slim bucket descriptor an enroll token carries. Mirrors the access-only
 *  subset of S3Config — no passphrase, no master key, no node-role hints. */
export interface EnrollPayload {
  endpoint: string;
  region?: string;
  bucket: string;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  encrypt?: boolean;
  virtualHostedStyle?: boolean;
}

// ---- base64url over a UTF-8 string (portable, no Buffer) ----------------------

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(token: string): string {
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Encode the bucket descriptor into a base64url enroll token. Keys are emitted
 *  in a fixed order (and undefined fields omitted) so the token is stable. */
export function encodeEnroll(p: EnrollPayload): string {
  const slim: EnrollPayload = {
    endpoint: p.endpoint,
    region: p.region,
    bucket: p.bucket,
    prefix: p.prefix,
    accessKeyId: p.accessKeyId,
    secretAccessKey: p.secretAccessKey,
    encrypt: p.encrypt,
    virtualHostedStyle: p.virtualHostedStyle,
  };
  return b64urlEncode(JSON.stringify(slim));
}

/** Decode an enroll token back into a bucket descriptor. Accepts the bare token,
 *  an `enroll=<token>` fragment, or a full `…/#enroll=<token>` deep link, so a
 *  user can paste whatever they copied. Throws MhError("invalid_input") on a
 *  malformed token or a payload missing the fields needed to reach the bucket. */
export function decodeEnroll(tokenOrUrl: string): EnrollPayload {
  const raw = (tokenOrUrl ?? "").trim();
  if (!raw) throw new MhError("invalid_input", "empty enroll code");
  // Pull the token out of a pasted link/fragment; otherwise treat the whole
  // string as the token.
  const m = /(?:[#&?]|^)enroll=([^&\s]+)/.exec(raw);
  const token = m ? m[1]! : raw;

  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(token));
  } catch {
    throw new MhError("invalid_input", "invalid enroll code (could not decode)");
  }
  if (!payload || typeof payload !== "object") {
    throw new MhError("invalid_input", "invalid enroll code (not an object)");
  }
  const p = payload as Record<string, unknown>;
  const need = (k: keyof EnrollPayload): string => {
    const v = p[k];
    if (typeof v !== "string" || v.trim() === "") {
      throw new MhError("invalid_input", `enroll code missing '${k}'`);
    }
    return v;
  };
  return {
    endpoint: need("endpoint"),
    bucket: need("bucket"),
    accessKeyId: need("accessKeyId"),
    secretAccessKey: need("secretAccessKey"),
    region: typeof p.region === "string" ? p.region : undefined,
    prefix: typeof p.prefix === "string" ? p.prefix : undefined,
    encrypt: typeof p.encrypt === "boolean" ? p.encrypt : undefined,
    virtualHostedStyle:
      typeof p.virtualHostedStyle === "boolean" ? p.virtualHostedStyle : undefined,
  };
}
