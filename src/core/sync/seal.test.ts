import { test, expect } from "bun:test";
import { generateSealKeypair, seal, openSealed } from "./seal.ts";
import { errorCode } from "../errors.ts";

async function authCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (e) {
    return errorCode(e);
  }
  return undefined;
}

test("seal/open roundtrip: empty, small, and 64KB payloads", async () => {
  const kp = await generateSealKeypair();
  for (const size of [0, 3, 1024, 64 * 1024]) {
    const pt = crypto.getRandomValues(new Uint8Array(size));
    const sealed = await seal(kp.publicKey, pt);
    // wire layout: epk(65) ‖ iv(12) ‖ ct(pt+16 GCM tag)
    expect(sealed.byteLength).toBe(65 + 12 + size + 16);
    const opened = await openSealed(kp.privateKey, kp.publicKey, sealed);
    expect(opened).toEqual(pt);
  }
});

test("every sealed box is unique (fresh ephemeral + iv)", async () => {
  const kp = await generateSealKeypair();
  const pt = new TextEncoder().encode("same plaintext");
  const a = await seal(kp.publicKey, pt);
  const b = await seal(kp.publicKey, pt);
  expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
});

test("tampering any byte fails with auth", async () => {
  const kp = await generateSealKeypair();
  const sealed = await seal(kp.publicKey, new TextEncoder().encode("hello inbox"));
  // flip a byte in each region: ephemeral key, iv, ciphertext, tag
  for (const idx of [10, 65 + 4, 65 + 12 + 2, sealed.byteLength - 1]) {
    const bad = new Uint8Array(sealed);
    bad[idx]! ^= 0xff;
    expect(await authCode(() => openSealed(kp.privateKey, kp.publicKey, bad))).toBe("auth");
  }
});

test("wrong recipient key fails with auth (and so does a truncated box)", async () => {
  const alice = await generateSealKeypair();
  const mallory = await generateSealKeypair();
  const sealed = await seal(alice.publicKey, new TextEncoder().encode("for alice"));
  expect(await authCode(() => openSealed(mallory.privateKey, mallory.publicKey, sealed))).toBe("auth");
  // right private key but wrong pk in the KDF info also fails (cross-key binding)
  expect(await authCode(() => openSealed(alice.privateKey, mallory.publicKey, sealed))).toBe("auth");
  expect(await authCode(() => openSealed(alice.privateKey, alice.publicKey, sealed.subarray(0, 60)))).toBe("auth");
});
