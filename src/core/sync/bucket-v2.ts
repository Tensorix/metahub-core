import type { DbDriver } from "../driver.ts";
import { knownDataVersion, observeDataVersion, requireSupportedVersion } from "./data-version.ts";
import { readReplicaGeneration } from "./retention-protocol.ts";
import { decodeUtf8 } from "./portable-json.ts";
import { z } from "zod";
import type { StorageClient, S3Config } from "./storage.ts";
import { storageBasePrefix, gzipStorageBytes, gunzipStorageBytes } from "./storage.ts";
import { createCommitLog, commitHash, type CommitCodec } from "./commit-log.ts";
import { initialRetentionState, reduceRetention } from "./retention-state.ts";
import { parseRetentionEvent } from "./retention-protocol.ts";
import { encryptBytes, decryptBytes, fromB64 } from "./e2ee.ts";
import { ChangeSchema } from "./protocol.ts";
import { CurrentCheckpointSchema, type CurrentCheckpoint } from "./current-checkpoint.ts";
import { MhError } from "../errors.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().nonnegative().safe();
export const BucketRootSchema = z.object({
  protocolVersion: z.literal(2), workspaceId: z.string().min(1).max(128),
  checkpoint: hash,
}).strict();
export const BucketBatchSchema = z.object({
  protocolVersion: z.literal(2), workspaceId: z.string(), epoch: counter,
  member: z.string(), first: counter.positive(), last: counter.positive(),
  changes: z.array(ChangeSchema).min(1),
  bases: z.array(z.string().nullable()).optional(),
}).strict().refine(b => b.last - b.first + 1 === b.changes.length && (!b.bases || b.bases.length === b.changes.length), "source sequence coverage mismatch");
export type BucketBatch = z.infer<typeof BucketBatchSchema>;
export type BucketRoot = z.infer<typeof BucketRootSchema>;
const MAX_OBJECT = 64 * 1024 * 1024;

/** All reads are exact-key reads. LIST/head hints never grant write or GC rights. */
export function createV2Bucket(client: StorageClient, config: S3Config, db?: DbDriver) {
  const prefix = `${storageBasePrefix(config.prefix)}/v2`;
  if (config.encrypt && !config.masterKey) throw new MhError("invalid_input", "missing workspace encryption key");
  const master = config.encrypt ? fromB64(config.masterKey!) : null;
  const codec: CommitCodec = {
    async encode(value) {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      if (bytes.length > MAX_OBJECT - 28) throw new MhError("invalid_input", "v2 object exceeds bounded object size");
      const compressed = await gzipStorageBytes(bytes);
      return master ? encryptBytes(master, compressed) : compressed;
    },
    async decode(bytes) {
      if (bytes.length > MAX_OBJECT) throw new MhError("invalid_input", "v2 object exceeds bounded object size");
      return JSON.parse(decodeUtf8(await gunzipStorageBytes(master ? await decryptBytes(master, bytes) : bytes, MAX_OBJECT)));
    },
  };
  async function read(key: string) {
    if (!client.getWithMetadata) throw new MhError("invalid_input", "v2 requires bounded metadata reads");
    return client.getWithMetadata(key, { maxBytes: MAX_OBJECT });
  }
  const objectKey = (digest: string) => `${prefix}/objects/${hash.parse(digest)}`;
  async function load(digest: string): Promise<unknown> {
    const result = await read(objectKey(digest));
    if (!result) throw new MhError("busy", "committed v2 object is not visible; retry without advancing coverage");
    if (await commitHash(result.bytes) !== digest) throw new MhError("invalid_input", "v2 object hash mismatch");
    return codec.decode(result.bytes);
  }
  async function publish(value: unknown): Promise<string> {
    const bytes = await codec.encode(value), digest = await commitHash(bytes);
    // Content addressing makes a retry safe even if its successful PUT response was lost.
    await client.put(objectKey(digest), bytes);
    const persisted = await read(objectKey(digest));
    if (!persisted || await commitHash(persisted.bytes) !== digest)
      throw new MhError("busy", "v2 object durability could not be verified");
    return digest;
  }
  let observedServerTime: number | null = null;
  let rootCommittedAt: number | null = null;
  async function root(): Promise<BucketRoot | null> {
    if (db) requireSupportedVersion(knownDataVersion(db)?.dataVersion ?? 2);
    const value = await read(`${prefix}/root`);
    if (!value && db && (knownDataVersion(db) || readReplicaGeneration(db))) throw new MhError("busy", "Known workspace root unavailable");
    if (value) { observedServerTime = value.serverDate; rootCommittedAt = value.lastModified; }
    if (!value) {
      // Even a first-time device must not treat a temporarily invisible v2
      // root as permission to publish a legacy batch over an existing log.
      if (await read(`${prefix}/control/0000000000000001.commit`))
        throw new MhError("busy", "Workspace control log exists but its root is unavailable");
      return null;
    }
    const root = BucketRootSchema.parse(await codec.decode(value.bytes));
    if (db) {
      const bound = readReplicaGeneration(db);
      if (bound && bound.workspaceId !== root.workspaceId) throw new MhError("rebootstrap_required", "workspace identity mismatch");
      const known = knownDataVersion(db);
      if (known && known.workspaceId !== root.workspaceId) throw new MhError("rebootstrap_required", "workspace identity mismatch");
    }
    return root;
  }
  async function initialize(checkpoint: CurrentCheckpoint): Promise<BucketRoot> {
    if (!await client.conditionalCreateCapability?.()) throw new MhError("invalid_input", "v2 requires atomic conditional creation");
    const existing = await root();
    if (existing) return existing;
    if (checkpoint.epoch !== 0) throw new MhError("invalid_input", "initial checkpoint must have epoch zero");
    const digest = await publish(CurrentCheckpointSchema.parse(checkpoint));
    const candidate: BucketRoot = { protocolVersion: 2, workspaceId: checkpoint.workspaceId, checkpoint: digest };
    try { await client.put(`${prefix}/root`, await codec.encode(candidate), { ifNoneMatch: true }); }
    catch (e) { if (!(e instanceof MhError) || e.code !== "conflict") throw e; }
    const winner = await root();
    if (!winner) throw new MhError("busy", "initialization result is not yet visible");
    // A losing migrator must preserve its old database and recover into the winner.
    await checkpointFor(winner, winner.checkpoint, 0);
    return winner;
  }
  async function checkpointFor(root: BucketRoot, digest: string, epoch: number) {
    const value = CurrentCheckpointSchema.parse(await load(digest));
    if (value.workspaceId !== root.workspaceId || value.epoch !== epoch)
      throw new MhError("invalid_input", "checkpoint identity mismatch");
    if (epoch === 0) {
      if (digest !== root.checkpoint || value.coveredSequence !== 0 || Object.keys(value.sourceCoverage).length)
        throw new MhError("invalid_input", "initial checkpoint has invalid coverage");
    } else {
      let covered = false, committed = false, changed = false;
      await log(root).read(undefined, async (record, after, rejected) => {
        if (record.sequence === value.coveredSequence) {
          const state = after.state;
          const expected = Object.fromEntries(Object.entries(state.members).map(([id, member]) => [id,member.sequence]));
          covered = state.epoch === epoch - 1 && !!state.preparing && state.preparing.members.every(id => state.members[id]!.sealed)
            && Object.keys(expected).length === Object.keys(value.sourceCoverage).length
            && Object.entries(expected).every(([id, seq]) => value.sourceCoverage[id] === seq);
        }
        if (rejected || record.sequence <= value.coveredSequence || committed) return;
        const event = record.payload;
        if ((event.type === "commit" || event.type === "upgrade") && event.checkpoint === digest && event.epoch === epoch - 1) {
          committed = covered && !changed && after.state.epoch === epoch;
        } else if (!["clock", "renew"].includes(event.type)) changed = true;
      });
      if (!committed) throw new MhError("invalid_input", "checkpoint lacks sealed source coverage proof");
    }
    return value;
  }
  function log(root: BucketRoot) {
    return createCommitLog({ client, prefix, workspaceId: root.workspaceId, codec,
      initialState: (): ReturnType<typeof initialRetentionState> => ({ ...initialRetentionState(), checkpoint: root.checkpoint }),
      parsePayload: parseRetentionEvent,
      reduce(state, event, at) {
        if (event.type === "upgrade" && event.workspaceId !== root.workspaceId) throw new MhError("conflict", "Workspace identity mismatch");
        return reduceRetention(state, event, at);
      },
      checkHead(state) {
        if (!db) return;
        const known = knownDataVersion(db);
        if (known && known.dataVersion > state.dataVersion) throw new MhError("busy", "Workspace data version moved backwards");
        if (!known || known.awaitingCompatibleClient) observeDataVersion(db, root.workspaceId, state.dataVersion);
      },
      validateProposal(event) {
        if (event.type === "upgrade") requireSupportedVersion(event.to);
        if (event.type === "prepare" && event.targetDataVersion) requireSupportedVersion(event.targetDataVersion);
      },
      checkAccepted(state, event) {
        if (event.type === "upgrade" && db) observeDataVersion(db, root.workspaceId, state.dataVersion);
        requireSupportedVersion(state.dataVersion);
      },
    });
  }
  async function batchFor(root: BucketRoot, event: { epoch: number; member: string; first: number; last: number; objectHash: string }) {
    const batch = BucketBatchSchema.parse(await load(event.objectHash));
    if (batch.workspaceId !== root.workspaceId || batch.epoch !== event.epoch || batch.member !== event.member || batch.first !== event.first || batch.last !== event.last)
      throw new MhError("invalid_input", "committed batch identity mismatch");
    return batch;
  }
  return { prefix, codec, root, initialize, publish, load, checkpointFor, log, batchFor, objectKey,
    serverTime: () => observedServerTime, rootCommittedAt: () => rootCommittedAt };
}
