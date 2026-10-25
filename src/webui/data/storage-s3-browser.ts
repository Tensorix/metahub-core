// Browser registration uses the same S3 wire adapter as native replicas.
import { setStorageClientFactory } from "../../core/sync/storage.ts";
import { createFetchStorageClient } from "../../core/sync/storage-s3-fetch.ts";

setStorageClientFactory(createFetchStorageClient);
