import { setStorageClientFactory } from "../../../../../src/core/sync/storage.ts";
import { createFetchStorageClient } from "../../../../../src/core/sync/storage-s3-fetch.ts";

export async function initializeNativeSyncRuntime(): Promise<void> {
  setStorageClientFactory(createFetchStorageClient);
}
