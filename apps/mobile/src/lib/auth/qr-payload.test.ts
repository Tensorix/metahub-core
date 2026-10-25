import { expect, test } from "bun:test";
import { parseQrPayload } from "./qr-payload";
import { decodeEnroll, encodeEnroll, mobileEnrollUrl } from "../../../../../src/core/sync/enroll.ts";

const config = { endpoint: "https://example.com", bucket: "test", accessKeyId: "test-id", secretAccessKey: "test-secret", encrypt: true };
test("native link and legacy web QR join the same bucket without carrying decryption keys", () => {
  const link = mobileEnrollUrl({ ...config, masterKey: "must-not-leak", passphrase: "must-not-leak" } as typeof config);
  for (const code of [link, "https://example.com/#enroll=" + encodeEnroll(config), "enroll=" + encodeEnroll(config)]) {
    const parsed = parseQrPayload(code);
    expect(parsed.kind).toBe("enroll");
    if (parsed.kind === "enroll") expect(decodeEnroll(parsed.code)).toEqual(config);
  }
  const payload = JSON.parse(atob(new URL(link).searchParams.get("enroll")!));
  expect(payload.masterKey).toBeUndefined();
  expect(payload.passphrase).toBeUndefined();
});
test("server QR remains supported, unrelated and empty invitations are rejected", () => {
  expect(parseQrPayload("https://example.com/?token=test")).toEqual({ kind: "server", baseUrl: "https://example.com", token: "test" });
  expect(parseQrPayload("metahub://connect?enroll=")).toEqual({ kind: "unknown" });
  expect(parseQrPayload("file:///private/config")).toEqual({ kind: "unknown" });
});
