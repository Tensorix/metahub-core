import { test, expect } from "bun:test";
import {
  generateMasterKey,
  wrapMasterKey,
  unwrapMasterKey,
  encryptBytes,
  decryptBytes,
} from "./e2ee.ts";
import { MhError } from "../errors.ts";

test("master key wraps and unwraps with the right passphrase", async () => {
  const K = generateMasterKey();
  const env = await wrapMasterKey(K, "correct horse battery staple");
  const back = await unwrapMasterKey(env, "correct horse battery staple");
  expect([...back]).toEqual([...K]);
});

test("wrong passphrase fails to unwrap with an auth error", async () => {
  const env = await wrapMasterKey(generateMasterKey(), "right-passphrase");
  try {
    await unwrapMasterKey(env, "wrong-passphrase");
    throw new Error("expected unwrap to throw");
  } catch (e) {
    expect(e).toBeInstanceOf(MhError);
    expect((e as MhError).code).toBe("auth");
  }
});

test("envelope is a JSON-stable shape and round-trips through serialization", async () => {
  const env = await wrapMasterKey(generateMasterKey(), "pw");
  expect(env.v).toBe(1);
  expect(env.kdf).toBe("PBKDF2-SHA256");
  expect(env.wrap).toBe("AES-GCM");
  expect(typeof env.salt).toBe("string");
  expect(typeof env.wrapped_key).toBe("string");
  const fromJson = JSON.parse(JSON.stringify(env));
  expect((await unwrapMasterKey(fromJson, "pw")).length).toBe(32);
});

test("segment encrypt/decrypt round-trips arbitrary bytes", async () => {
  const K = generateMasterKey();
  const data = new TextEncoder().encode("hello \u{1f510} world".repeat(100));
  const dec = await decryptBytes(K, await encryptBytes(K, data));
  expect(new TextDecoder().decode(dec)).toBe(new TextDecoder().decode(data));
});

test("decrypting with a different key fails with an auth error", async () => {
  const enc = await encryptBytes(generateMasterKey(), new TextEncoder().encode("secret"));
  try {
    await decryptBytes(generateMasterKey(), enc);
    throw new Error("expected decrypt to throw");
  } catch (e) {
    expect((e as MhError).code).toBe("auth");
  }
});

test("tampered ciphertext fails the GCM authentication tag", async () => {
  const K = generateMasterKey();
  const enc = await encryptBytes(K, new TextEncoder().encode("data"));
  enc[enc.length - 1] = (enc[enc.length - 1] ?? 0) ^ 0xff; // flip a byte
  await expect(decryptBytes(K, enc)).rejects.toThrow();
});

test("two encryptions of the same plaintext differ (random IV)", async () => {
  const K = generateMasterKey();
  const a = await encryptBytes(K, new TextEncoder().encode("x"));
  const b = await encryptBytes(K, new TextEncoder().encode("x"));
  expect([...a]).not.toEqual([...b]);
});
