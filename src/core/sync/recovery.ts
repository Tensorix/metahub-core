// Recovery code: a printable, typo-safe encoding of the bucket master key K.
// The passphrase can be RESET with it (unwrap-less rewrap of keys/main.json),
// and a fresh device can join without the passphrase at all — so a printed card
// is the last-resort backup for "every device is gone AND the passphrase is
// forgotten". Anyone holding the code can read all data; the card says so.
//
// Format: `MH1-` + Crockford base32 of (K ‖ first 3 bytes of SHA-256(K)),
// 35 bytes = 280 bits = exactly 56 chars, rendered as 14 groups of 4. The
// checksum catches any single-character typo (and ~all others: 2^-24 miss
// odds); Crockford's alphabet drops I/L/O/U and decode folds o→0, i/l→1, so
// hand-copied cards survive the usual confusions.
//
// Runtime-agnostic like e2ee.ts: WebCrypto only.

import { MhError } from "../errors.ts";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_BYTES = 32;
const CHECK_BYTES = 3;
const CODE_CHARS = ((KEY_BYTES + CHECK_BYTES) * 8) / 5; // 56
const GROUP = 4;

export const RECOVERY_PREFIX = "MH1";

function ab(u: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(u.byteLength);
  out.set(u);
  return out.buffer;
}

async function checksum(rawKey: Uint8Array): Promise<Uint8Array> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ab(rawKey)));
  return digest.subarray(0, CHECK_BYTES);
}

function b32encode(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31]!;
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31]!;
  return out;
}

function b32decode(s: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new MhError("invalid_input", `invalid recovery-code character: ${ch}`);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

/** Encode the raw 32-byte master key as a grouped, prefixed recovery code. */
export async function encodeRecoveryCode(rawKey: Uint8Array): Promise<string> {
  if (rawKey.length !== KEY_BYTES)
    throw new MhError("invalid_input", `master key must be ${KEY_BYTES} bytes`);
  const payload = new Uint8Array(KEY_BYTES + CHECK_BYTES);
  payload.set(rawKey, 0);
  payload.set(await checksum(rawKey), KEY_BYTES);
  const chars = b32encode(payload);
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += GROUP) groups.push(chars.slice(i, i + GROUP));
  return `${RECOVERY_PREFIX}-${groups.join("-")}`;
}

/** Decode a (possibly sloppily pasted) recovery code back to the raw master
 *  key. Tolerates case, spaces, dashes and the o→0 / i,l→1 confusions; throws
 *  MhError("invalid_input") on bad characters, wrong length, or a failed
 *  checksum (a typo the confusion-folding couldn't absorb). */
export async function decodeRecoveryCode(code: string): Promise<Uint8Array> {
  let s = code.toUpperCase().replace(/[\s-]/g, "");
  if (s.startsWith(RECOVERY_PREFIX)) s = s.slice(RECOVERY_PREFIX.length);
  s = s.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== CODE_CHARS)
    throw new MhError(
      "invalid_input",
      `recovery code must be ${CODE_CHARS} characters (${s.length} given)`,
    );
  const payload = b32decode(s);
  const rawKey = payload.subarray(0, KEY_BYTES);
  const expect = await checksum(rawKey);
  const got = payload.subarray(KEY_BYTES, KEY_BYTES + CHECK_BYTES);
  if (expect.length !== got.length || !expect.every((b, i) => b === got[i]))
    throw new MhError("invalid_input", "recovery code checksum failed — please re-check the code");
  return new Uint8Array(rawKey);
}
