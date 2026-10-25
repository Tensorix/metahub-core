import { toB64 } from "../../../../../src/core/sync/e2ee.ts";
import { decodeRecoveryCode } from "../../../../../src/core/sync/recovery.ts";
import {
  provisionMasterKey,
  verifyMasterKey,
  type S3Config,
  type StorageClient,
} from "../../../../../src/core/sync/storage.ts";

export type BucketUnlock =
  | { method: "passphrase"; passphrase: string }
  | { method: "recovery"; recoveryCode: string };

/** Resolve local credentials using the same join protocol as the CLI. Recovery
 * joins only read ciphertext: they never provision or replace the key envelope. */
export async function resolveBucketEnrollment(
  client: StorageClient,
  config: S3Config,
  unlock: BucketUnlock,
  signal: AbortSignal,
): Promise<S3Config> {
  const assertActive = () => {
    if (signal.aborted) throw new Error("连接已取消");
  };
  assertActive();
  // Never adopt a key supplied by an access-settings payload or an old attempt.
  const resolved = { ...config };
  delete resolved.masterKey;
  if (!resolved.encrypt) {
    await client.list(`${resolved.prefix}/`);
  } else if (unlock.method === "recovery") {
    if (!unlock.recoveryCode.trim()) throw new Error("请输入存储桶恢复码");
    const rawKey = await decodeRecoveryCode(unlock.recoveryCode);
    assertActive();
    // As on the CLI, an empty bucket may have no ciphertext to verify yet.
    // A key for a different bucket fails AES-GCM authentication when data exists.
    await verifyMasterKey(client, resolved, rawKey);
    assertActive();
    resolved.masterKey = toB64(rawKey);
  } else {
    if (!unlock.passphrase) throw new Error("请输入存储桶解密密码");
    resolved.masterKey =
      (await provisionMasterKey(client, resolved, unlock.passphrase)) ?? undefined;
  }
  assertActive();
  return resolved;
}
