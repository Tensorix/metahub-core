import { test, expect } from "bun:test";
import { encodeRecoveryCode, decodeRecoveryCode, RECOVERY_PREFIX } from "./recovery.ts";
import { generateMasterKey } from "./e2ee.ts";

test("roundtrip: encode → decode returns the same key", async () => {
  const k = generateMasterKey();
  const code = await encodeRecoveryCode(k);
  expect(code.startsWith(`${RECOVERY_PREFIX}-`)).toBe(true);
  // 14 groups of 4 + prefix
  expect(code.split("-")).toHaveLength(15);
  expect(code.replace(/^MH1-/, "").replace(/-/g, "")).toHaveLength(56);
  const back = await decodeRecoveryCode(code);
  expect([...back]).toEqual([...k]);
});

test("decode tolerates case, spacing, dashes and o/i/l confusables", async () => {
  const k = generateMasterKey();
  const code = await encodeRecoveryCode(k);
  const sloppy = code.toLowerCase().replace(/-/g, " ");
  expect([...(await decodeRecoveryCode(sloppy))]).toEqual([...k]);
  // fold 0→o and 1→i/l in the body; decode must map them back
  const body = code.slice(4);
  const confused = `${RECOVERY_PREFIX}-` + body.replace(/0/g, "O").replace(/1/g, "l");
  expect([...(await decodeRecoveryCode(confused))]).toEqual([...k]);
});

test("every single-character flip is detected", async () => {
  const k = generateMasterKey();
  const compact = (await encodeRecoveryCode(k)).replace(/^MH1-/, "").replace(/-/g, "");
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let detected = 0;
  let silent = 0;
  for (let i = 0; i < compact.length; i++) {
    const orig = compact[i]!;
    const flipped = ALPHABET[(ALPHABET.indexOf(orig) + 7) % 32]!;
    const mutated = compact.slice(0, i) + flipped + compact.slice(i + 1);
    try {
      await decodeRecoveryCode(mutated);
      // decoding SUCCEEDED on a corrupted code → the checksum missed it
      silent++;
    } catch {
      detected++;
    }
  }
  expect(silent).toBe(0);
  expect(detected).toBe(compact.length);
});

test("truncated / overlong / bad prefix / garbage all throw invalid_input", async () => {
  const k = generateMasterKey();
  const code = await encodeRecoveryCode(k);
  for (const bad of [code.slice(0, -3), code + "AAAA", "MH2-" + code.slice(4), "not a code", ""]) {
    await expect(decodeRecoveryCode(bad)).rejects.toThrow();
  }
});

test("checksum failure names itself (typo within alphabet)", async () => {
  const k = generateMasterKey();
  const code = await encodeRecoveryCode(k);
  const body = code.slice(4).replace(/-/g, "");
  const ch = body[10] === "A" ? "B" : "A";
  const mutated = "MH1-" + body.slice(0, 10) + ch + body.slice(11);
  await expect(decodeRecoveryCode(mutated)).rejects.toThrow(/checksum|character/);
});
