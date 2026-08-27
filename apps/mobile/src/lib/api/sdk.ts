// Single point where the app reaches outside its own root: the repo's
// isomorphic SDK (served to browsers at /metahub-sdk.js, dependency-free,
// feature-detects localStorage/AbortSignal — safe under Hermes). Everything
// else in the app imports from here, never from ../../src directly.
import type { createClient as _createClient } from "../../../../../src/sdk/client.ts";

export {
  createClient,
  MetahubError,
  type SdkOptions,
  type DbInfo,
  type PropInfo,
  type RecordInfo,
  type DocSummaryInfo,
  type DocInfo,
  type SearchHitInfo,
} from "../../../../../src/sdk/client.ts";

/** The SDK's client instance type (createClient has no named return type). */
export type MetahubClient = ReturnType<typeof _createClient>;
