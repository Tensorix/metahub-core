import { z } from "zod";
import type { Change as CrdtChange } from "../crdt.ts";

// Single source of truth: these Zod schemas drive runtime validation *and*
// the auto-generated OpenAPI docs (see ./openapi.ts). `.describe(...)` text
// flows straight into the published spec.

export const ChangeSchema = z.object({
  hlc: z.string().describe("Hybrid Logical Clock timestamp"),
  node_id: z.string().describe("Origin node that produced the change"),
  dataset: z.string().describe("CRDT dataset, e.g. databases / records / documents"),
  row_id: z.string().describe("Row identifier within the dataset"),
  col: z.string().describe("Column / property identifier"),
  value: z.string().nullable().describe("JSON-encoded field value, or null"),
  // Change-group id for history rendering; optional so pre-txn peers interop
  // (their changes simply fall back to time-gap clustering in history views).
  txn: z.string().nullable().optional().describe("Change-group id (one logical mutation)"),
});

export const SyncRequestSchema = z.object({
  node_id: z.string().describe("Calling client's node id"),
  since: z.number().describe("Server cursor the client last pulled"),
  changes: z.array(ChangeSchema).describe("Client's changes to push"),
  // Both optional and absent in classic peer rounds (full pull). Browser
  // replicas use them: `limit` chunks the initial hydration into bounded
  // pulls, `exclude_datasets` lets a device opt out of heavy datasets it
  // never edits (e.g. site_files on a small phone).
  limit: z.number().optional().describe("Max changes to return (pagination for hydration)"),
  exclude_datasets: z
    .array(z.string())
    .optional()
    .describe("Datasets to omit from the pull (partial replica)"),
});

export const SyncResponseSchema = z.object({
  node_id: z.string().describe("Server's node id"),
  changes: z.array(ChangeSchema).describe("Server changes after `since`"),
  cursor: z.number().describe("New server cursor for the client to store"),
});

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  node: z.string().describe("Server's node id"),
  capabilities: z
    .array(z.string())
    .optional()
    .describe("Optional protocol features supported by this server"),
  version: z
    .string()
    .optional()
    .describe("Core version, for mixed-version workspace warnings"),
});

// Pairing handshake (see ./pairing.ts). The caller (device B) presents a
// one-time code, its node id, the durable credential it issues to us, and
// optionally its own reachable URL so we can register it back as a peer.
export const PairRequestSchema = z.object({
  code: z.string().describe("One-time pairing code minted by this server"),
  node_id: z.string().describe("Calling device's node id"),
  grant: z.string().describe("Durable credential the caller issues to us"),
  self_url: z.string().optional().describe("Caller's reachable server URL (for mutual sync)"),
});

export const PairResponseSchema = z.object({
  node_id: z.string().describe("This server's node id"),
  grant: z.string().describe("Durable credential we issue to the caller"),
});

export type PairRequest = z.infer<typeof PairRequestSchema>;
export type PairResponse = z.infer<typeof PairResponseSchema>;

// `Change` stays sourced from crdt.ts to avoid a second source of truth; the
// schema above is structurally compatible and used only for validation/docs.
export type SyncRequest = z.infer<typeof SyncRequestSchema> & { changes: CrdtChange[] };
export type SyncResponse = z.infer<typeof SyncResponseSchema> & { changes: CrdtChange[] };
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const SYNC_PATH = "/sync";
export const HEALTH_PATH = "/health";
// Token exchange: a holder of the current (or an in-grace previous) token swaps
// it for the current token. Exempt from the gate so an expired token can reach it.
export const RENEW_PATH = "/auth/token";
// Pairing handshake. Exempt from the master-token gate because the caller only
// holds a one-time code (validated inside the handler), not the server token.
export const PAIR_PATH = "/api/pair";
