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
});

export const SyncRequestSchema = z.object({
  node_id: z.string().describe("Calling client's node id"),
  since: z.number().describe("Server cursor the client last pulled"),
  changes: z.array(ChangeSchema).describe("Client's changes to push"),
});

export const SyncResponseSchema = z.object({
  node_id: z.string().describe("Server's node id"),
  changes: z.array(ChangeSchema).describe("Server changes after `since`"),
  cursor: z.number().describe("New server cursor for the client to store"),
});

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  node: z.string().describe("Server's node id"),
});

// `Change` stays sourced from crdt.ts to avoid a second source of truth; the
// schema above is structurally compatible and used only for validation/docs.
export type SyncRequest = z.infer<typeof SyncRequestSchema> & { changes: CrdtChange[] };
export type SyncResponse = z.infer<typeof SyncResponseSchema> & { changes: CrdtChange[] };
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const SYNC_PATH = "/sync";
export const HEALTH_PATH = "/health";
