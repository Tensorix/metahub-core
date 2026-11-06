// Test-only adapter for the local fixture, whose server implements conditional
// creation. Production endpoints still require a verified provider capability.
import "../../src/webui/data/db-worker.ts";
import { setStorageClientFactory } from "../../src/core/sync/storage.ts";
import { createFetchStorageClient } from "../../src/core/sync/storage-s3-fetch.ts";
setStorageClientFactory((config, options) => ({ ...createFetchStorageClient(config, options), conditionalCreateCapability: async () => true }));
