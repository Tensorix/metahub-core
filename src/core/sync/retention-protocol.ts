import { assertWorkspaceWritable, localDataVersion, dataVersionRange } from "./data-version.ts";
import { z } from "zod";
import { MhError } from "../errors.ts";
import type { DbDriver } from "../driver.ts";
import type { RetentionEvent } from "./retention-state.ts";

const integer = z.number().int().nonnegative().safe();
const epoch = integer;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const member = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).refine(v => !["__proto__", "constructor", "prototype"].includes(v));
const checkpoint = hash.nullable();
export const RetentionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("upgrade"), workspaceId: z.string().min(1), epoch, id: member, from: integer, to: integer, checkpoint: hash }).strict(),
  z.object({ type: z.literal("clock") }).strict(),
  z.object({ type: z.literal("join"), epoch, member, checkpoint, replaces: z.object({ member, sequence: integer }).strict().optional() }).strict(),
  z.object({ type: z.literal("batch"), epoch, member, first: integer.positive(), last: integer.positive(), objectHash: hash }).strict(),
  z.object({ type: z.literal("renew"), epoch, member, sequence: integer, checkpoint }).strict(),
  z.object({ type: z.literal("prepare"), epoch, id: member, targetDataVersion: integer.positive().optional() }).strict(),
  z.object({ type: z.literal("seal"), epoch, id: member, member, sequence: integer }).strict(),
  z.object({ type: z.literal("cancel"), epoch, id: member }).strict(),
  z.object({ type: z.literal("commit"), epoch, id: member, checkpoint: hash }).strict(),
]);
export function parseRetentionEvent(value: unknown): RetentionEvent {
  const parsed = RetentionEventSchema.safeParse(value);
  if (!parsed.success) throw new MhError("invalid_input", "invalid retention event");
  return parsed.data;
}
export const ReplicaGenerationSchema = z.object({
  protocolVersion: z.literal(2), workspaceId: z.string().min(1).max(128), epoch,
  incarnationId: member, checkpoint,
}).strict();
export type ReplicaGeneration = z.infer<typeof ReplicaGenerationSchema>;
const key = "sync_v2_generation";
export function readReplicaGeneration(db: DbDriver): ReplicaGeneration | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  if (!row) return null;
  const parsed = ReplicaGenerationSchema.safeParse(JSON.parse(row.value));
  if (!parsed.success) throw new MhError("rebootstrap_required", "local synchronization generation is invalid");
  return parsed.data;
}
/** Storage v2 records local upload progress per incarnation. Do not credit a
 * different bucket with that acknowledgement when reporting its status. */
export function bucketPushCursor(db: DbDriver, url: string, peerCursor: number): number {
  const generation = readReplicaGeneration(db);
  if (!generation) return peerCursor;
  const bound = db.query("SELECT value FROM meta WHERE key='local_v2_history_peer'").get() as { value: string } | null;
  if (bound ? bound.value !== url : db.query("SELECT 1 FROM peers WHERE kind='s3' AND url<>? LIMIT 1").get(url))
    return peerCursor;
  const progress = db.query("SELECT value FROM meta WHERE key=?").get(`sync_v2_transport:${generation.incarnationId}`) as { value: string } | null;
  return progress ? JSON.parse(progress.value).cursor : 0;
}

export function needsBucketUpgrade(db: DbDriver, url: string): boolean {
  if (localDataVersion(db) > dataVersionRange.maxSupportedDataVersion) return false;
  const row = db.query("SELECT value FROM meta WHERE key=?").get(`sync_workspace_access:${url}`) as { value: string } | null;
  if (row) {
    const state = JSON.parse(row.value);
    return state.kind === "migration" || state.kind === "rebuild";
  }
  return !!db.query("SELECT 1 FROM meta WHERE key=?").get(`sync_v2_rebuild_required:${url}`);
}

export function writeReplicaGeneration(db: DbDriver, value: ReplicaGeneration): void {
  const next = ReplicaGenerationSchema.parse(value), current = readReplicaGeneration(db);
  if (current && (next.workspaceId !== current.workspaceId || next.epoch < current.epoch))
    throw new MhError("rebootstrap_required", "workspace or synchronization generation cannot roll back");
  if (current && next.epoch === current.epoch && next.checkpoint !== current.checkpoint)
    throw new MhError("rebootstrap_required", "checkpoint cannot change within a synchronization generation");
  db.query("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(next));
}
/** Gate before any ingestion, upload, cursor acknowledgement, or backup merge. */
export function assertReplicaGeneration(db: DbDriver, remote: unknown): void {
  assertWorkspaceWritable(db);
  const local = readReplicaGeneration(db);
  if (!local) {
    if (remote != null) throw new MhError("upgrade_required", "workspace migration is required");
    return;
  }
  const parsed = ReplicaGenerationSchema.safeParse(remote);
  if (!parsed.success) throw new MhError("upgrade_required", "sync protocol version 2 is required");
  if (parsed.data.workspaceId !== local.workspaceId || parsed.data.epoch !== local.epoch || parsed.data.checkpoint !== local.checkpoint)
    throw new MhError("rebootstrap_required", "synchronization checkpoint is obsolete");
}
