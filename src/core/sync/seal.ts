// MH-SEAL-P256 — an anonymous "sealed box" over pure WebCrypto, used by the
// write-inbox (drop) transport: a visitor's browser seals a payload to the
// owner's published P-256 public key; only a device holding the private key can
// open it. The edge host relays ciphertext it can never read.
//
// Construction (ECIES): fresh ephemeral ECDH P-256 keypair per seal →
// ECDH(ephemeral, recipient) shared secret → HKDF-SHA256 with
// info = "mh-drop-seal-v1" ‖ epk_raw ‖ SHA-256(recipient_pk_raw) → AES-256-GCM.
// Binding the ephemeral AND recipient key into the KDF info stops cross-key
// replay (a ciphertext sealed for key A can never open under key B, even with
// an attacker-chosen ephemeral).
//
// Wire format: epk_raw(65 bytes, uncompressed point) ‖ iv(12) ‖ ciphertext+tag.
//
// PORTABLE: global WebCrypto only (Bun, browsers, workerd) — no node:/bun:
// imports, no third-party crypto. The envelope's `enc` field ("sealed-p256")
// is the agility hook for a future X25519 variant.

import { MhError } from "../errors.ts";

export const SEAL_ENC = "sealed-p256";
const EPK_BYTES = 65; // uncompressed P-256 point (0x04 ‖ x ‖ y)
const IV_BYTES = 12;
const INFO_TAG = "mh-drop-seal-v1";
const CURVE = { name: "ECDH", namedCurve: "P-256" } as const;

/** Copy into a fresh ArrayBuffer (WebCrypto wants BufferSource without the
 *  TS 5.7 ArrayBufferLike widening headaches; same helper as e2ee.ts). */
function ab(u: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(u.byteLength);
  out.set(u);
  return out.buffer;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export interface SealKeypair {
  /** Raw uncompressed public point (65 bytes) — what mh-drop.json publishes. */
  publicKey: Uint8Array;
  /** PKCS#8 private key — wrapped with the master key before it leaves the device. */
  privateKey: Uint8Array;
}

/** A fresh P-256 keypair for a drop recipient. Independent generation is a
 *  design decision, not a shortcut: WebCrypto cannot derive a P-256 keypair
 *  from a seed, so "derive from the master key" is technically impossible. */
export async function generateSealKeypair(): Promise<SealKeypair> {
  const kp = await crypto.subtle.generateKey(CURVE, true, ["deriveBits"]);
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)),
    privateKey: new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)),
  };
}

/** HKDF the ECDH shared secret into the message key, binding ephemeral +
 *  recipient identities into `info` (see module header). */
async function deriveSealKey(
  sharedBits: ArrayBuffer,
  epkRaw: Uint8Array,
  recipientPkRaw: Uint8Array,
): Promise<CryptoKey> {
  const pkHash = new Uint8Array(await crypto.subtle.digest("SHA-256", ab(recipientPkRaw)));
  const info = concatBytes(new TextEncoder().encode(INFO_TAG), epkRaw, pkHash);
  const ikm = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(16).buffer, info: ab(info) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seal plaintext to a recipient's raw P-256 public key (anonymous sender). */
export async function seal(recipientPkRaw: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const recipient = await crypto.subtle.importKey("raw", ab(recipientPkRaw), CURVE, false, []);
  const eph = await crypto.subtle.generateKey(CURVE, true, ["deriveBits"]);
  const epkRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: recipient }, eph.privateKey, 256);
  const key = await deriveSealKey(shared, epkRaw, recipientPkRaw);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv) }, key, ab(plaintext)));
  return concatBytes(epkRaw, iv, ct);
}

/**
 * Open a sealed box with the recipient's PKCS#8 private key (+ its raw public
 * key, which the keyring stores alongside — needed to rebuild the KDF info).
 * EVERY failure mode — truncated input, bad ephemeral point, wrong key,
 * tampered ciphertext — answers with the same MhError("auth"), so a caller
 * can't distinguish "wrong key" from "corrupted": both mean "not for you".
 */
export async function openSealed(
  privateKeyPkcs8: Uint8Array,
  recipientPkRaw: Uint8Array,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  try {
    if (sealed.byteLength < EPK_BYTES + IV_BYTES + 16) throw new Error("short");
    const epkRaw = sealed.subarray(0, EPK_BYTES);
    const iv = sealed.subarray(EPK_BYTES, EPK_BYTES + IV_BYTES);
    const ct = sealed.subarray(EPK_BYTES + IV_BYTES);
    const sk = await crypto.subtle.importKey("pkcs8", ab(privateKeyPkcs8), CURVE, false, ["deriveBits"]);
    const epk = await crypto.subtle.importKey("raw", ab(epkRaw), CURVE, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: epk }, sk, 256);
    const key = await deriveSealKey(shared, new Uint8Array(epkRaw), recipientPkRaw);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ab(new Uint8Array(iv)) }, key, ab(new Uint8Array(ct)));
    return new Uint8Array(pt);
  } catch {
    throw new MhError("auth", "could not open sealed envelope — wrong key or corrupt data");
  }
}
