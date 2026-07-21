// End-to-end encryption for storage-sync (sync/storage.ts). The bucket is a
// third-party dumb store, so every oplog segment and snapshot is encrypted
// before it leaves the device; the bucket only ever holds ciphertext.
//
// Two key layers (the Joplin / age-style envelope):
//   - Master key K (random 256-bit): encrypts every segment and snapshot. Kept
//     locally as raw bytes (peers.config — same trust model as peer tokens).
//   - KEK, derived from the user's passphrase via PBKDF2: wraps K into the
//     bucket's keys/main.json. Any new device recovers K from
//     bucket-credentials + passphrase alone — no device-to-device key transfer.
//
// We wrap K by AES-GCM-encrypting its raw bytes rather than via WebCrypto's
// AES-KW: AES-GCM + PBKDF2 are present in every runtime we target (Bun and the
// browser worker), AES-KW support is uneven. A wrong passphrase fails the GCM
// auth tag, which we surface as an MhError.
//
// Runtime-agnostic: uses only the global WebCrypto (`crypto.subtle`,
// `crypto.getRandomValues`) and btoa/atob, all present on Bun and in browsers.

import { MhError } from "../errors.ts";

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12; // AES-GCM standard nonce length
const KEY_BYTES = 32; // AES-256

// TS 5.7 widens `Uint8Array` to `Uint8Array<ArrayBufferLike>`. Give WebCrypto an
// explicit ArrayBuffer without naming DOM-only helper types in declaration builds.
function ab(u: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(u.byteLength);
  out.set(u);
  return out.buffer;
}

/** The bucket's keys/main.json: the master key wrapped by the passphrase KEK. */
export interface KeyEnvelope {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iter: number;
  salt: string; // base64
  wrap: "AES-GCM";
  /** base64(iv ‖ ciphertext) of the raw 32-byte master key. */
  wrapped_key: string;
}

// ---- base64 (portable: no Buffer dependency) ----------------------------------

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** base64url (RFC 4648 §5, unpadded) of raw bytes — for OAuth PKCE verifiers and
 *  SHA-256 challenges, where the value travels in a URL query. */
export function toB64url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- master key ----------------------------------------------------------------

/** A fresh random 256-bit master key (raw bytes). */
export function generateMasterKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

async function deriveKek(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    ab(new TextEncoder().encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: ab(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Wrap the master key under a passphrase-derived KEK → bucket keys/main.json. */
export async function wrapMasterKey(rawKey: Uint8Array, passphrase: string): Promise<KeyEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const kek = await deriveKek(passphrase, salt);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv) }, kek, ab(rawKey)),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iter: PBKDF2_ITERATIONS,
    salt: toB64(salt),
    wrap: "AES-GCM",
    wrapped_key: toB64(packed),
  };
}

/** Recover the master key from the envelope + passphrase. Throws `auth` on a
 *  wrong passphrase (the GCM tag won't verify) or a malformed envelope. */
export async function unwrapMasterKey(env: KeyEnvelope, passphrase: string): Promise<Uint8Array> {
  if (env.v !== 1 || env.kdf !== "PBKDF2-SHA256" || env.wrap !== "AES-GCM")
    throw new MhError("invalid_input", "unsupported key envelope format");
  const salt = fromB64(env.salt);
  const kek = await deriveKek(passphrase, salt);
  const packed = fromB64(env.wrapped_key);
  const iv = packed.subarray(0, IV_BYTES);
  const ct = packed.subarray(IV_BYTES);
  try {
    const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ab(iv) }, kek, ab(ct));
    return new Uint8Array(raw);
  } catch {
    throw new MhError("auth", "wrong passphrase — could not unwrap the master key");
  }
}

/**
 * Derive a raw 32-byte content key from a share password + salt (same PBKDF2
 * parameters as the bucket KEK). Used by the object-storage share path: the
 * exporter and the in-browser viewer both derive the identical key, so a wrong
 * password simply fails the GCM tag on decrypt — no server-side verifier needed.
 */
export async function deriveShareKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey(
    "raw",
    ab(new TextEncoder().encode(password)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: ab(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    256,
  );
  return new Uint8Array(bits);
}

// ---- segment encryption --------------------------------------------------------

async function importGcmKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", ab(rawKey), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypt arbitrary bytes (a compressed segment/snapshot) → iv ‖ ciphertext. */
export async function encryptBytes(rawKey: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const key = await importGcmKey(rawKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv) }, key, ab(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

/** Inverse of encryptBytes. Throws `auth` if the key is wrong or data tampered. */
export async function decryptBytes(rawKey: Uint8Array, payload: Uint8Array): Promise<Uint8Array> {
  const key = await importGcmKey(rawKey);
  const iv = payload.subarray(0, IV_BYTES);
  const ct = payload.subarray(IV_BYTES);
  try {
    const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ab(iv) }, key, ab(ct));
    return new Uint8Array(raw);
  } catch {
    throw new MhError("auth", "could not decrypt — wrong master key or corrupt data");
  }
}
