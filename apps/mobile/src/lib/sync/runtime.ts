import { setPasswordKdf } from "../../../../../src/core/sync/e2ee.ts";
import QuickCrypto from "react-native-quick-crypto";
import {
  setStorageClientFactory,
  setStorageCompressionCodec,
} from "../../../../../src/core/sync/storage.ts";
import { createFetchStorageClient } from "../../../../../src/core/sync/storage-s3-fetch.ts";
import { nativeStorageCodec } from "./codec";

let initialized: Promise<void> | undefined;

/** Install native WebCrypto before opening a replica or signing requests. The
 * shared E2EE, key envelope and SigV4 implementations consume these globals.
 * No credentials or key material are persisted by this runtime adapter. */
export function initializeNativeSyncRuntime(): Promise<void> {
  return (initialized ??= Promise.resolve().then(() => {
    const nativeCrypto = QuickCrypto as unknown as Crypto;
    if (!nativeCrypto.subtle || !nativeCrypto.getRandomValues)
      throw new Error("Native sync crypto is unavailable; install a development build");
    Object.defineProperty(globalThis, "crypto", { value: nativeCrypto, configurable: true });
    setPasswordKdf((passphrase, salt, iterations) => new Promise((resolve, reject) => {
      QuickCrypto.pbkdf2(passphrase, salt, iterations, 32, "sha256", (error, key) => {
        if (error) reject(error); else if (!key) reject(new Error("Native PBKDF2 returned no key")); else resolve(new Uint8Array(key));
      });
    }));
    setStorageCompressionCodec(nativeStorageCodec);
    setStorageClientFactory(createFetchStorageClient);
  }).catch((error: unknown) => {
    initialized = undefined;
    throw error;
  }));
}
