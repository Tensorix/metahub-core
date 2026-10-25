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
    setStorageCompressionCodec(nativeStorageCodec);
    setStorageClientFactory(createFetchStorageClient);
  }).catch((error: unknown) => {
    initialized = undefined;
    throw error;
  }));
}
