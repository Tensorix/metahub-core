import { z } from "zod";
import type { DbDriver } from "../driver.ts";
import { writeTx } from "../driver.ts";
import { MhError } from "../errors.ts";
import { dataVersionRange, localDataVersion, observeDataVersion, requireSupportedVersion } from "./data-version.ts";
import { captureCurrentCheckpoint, CurrentCheckpointSchema } from "./current-checkpoint.ts";
import { editBases, ingestPeerChanges } from "./peer-v2.ts";
import { HealthResponseSchema } from "./protocol.ts";
import { ReplicaGenerationSchema, readReplicaGeneration, assertReplicaGeneration } from "./retention-protocol.ts";
import { commitHash } from "./commit-log.ts";
import { syncWithPeer } from "./client.ts";
import { withSyncBudget } from "./transport.ts";
import { classifyWorkspaceAccess, setWorkspaceAccess, workspaceAccessError, type WorkspaceAccess } from "./workspace-access.ts";
import { recoverWorkspace, type RecoveryAdapter, type WorkspaceSnapshotSource } from "./recovery-v2.ts";

export const BOOTSTRAP_PATH = "/sync/bootstrap";
export const BOOTSTRAP_CAPABILITY = "sync_bootstrap_v1";
export const BootstrapRequestSchema = z.object({
  minSupportedDataVersion: z.number().int().positive().safe(), maxSupportedDataVersion: z.number().int().positive().safe(),
  workspaceId: z.string().min(1), epoch: z.number().int().nonnegative().safe(), checkpoint: z.string().nullable(),
}).strict();
const SnapshotSchema = z.object({ dataVersion: z.number().int().positive().safe(), generation: ReplicaGenerationSchema,
  node_id: z.string().min(1), cursor: z.number().int().nonnegative().safe(), current: CurrentCheckpointSchema,
  bases: z.array(z.string().nullable()),
}).strict();
export const BootstrapResponseSchema = z.object({ snapshot: SnapshotSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export async function captureHttpBootstrap(db: DbDriver, node: string, input: unknown) {
  const request = BootstrapRequestSchema.parse(input);
  const snapshot = writeTx(db, () => {
    const dataVersion = localDataVersion(db);
    requireSupportedVersion(dataVersion, request.maxSupportedDataVersion, request.minSupportedDataVersion);
    requireSupportedVersion(dataVersion);
    const generation = readReplicaGeneration(db);
    if (!generation) throw new MhError("upgrade_required", "HTTP bootstrap requires a v2 workspace");
    if (generation.workspaceId !== request.workspaceId || generation.epoch !== request.epoch || generation.checkpoint !== request.checkpoint)
      throw new MhError("rebootstrap_required", "workspace changed before snapshot capture");
    const current = captureCurrentCheckpoint(db, generation.workspaceId, generation.epoch);
    // Local recovery packages are device-private. HTTP state is not proof of
    // control-log coverage, even when this server also has a bucket connection.
    current.pendingRecovery = []; current.history = []; current.coveredSequence = 0; current.sourceCoverage = {};
    const cursor = (db.query("SELECT COALESCE(MAX(seq),0) AS cursor FROM crdt_changes").get() as { cursor: number }).cursor;
    return { dataVersion, generation, node_id: node, cursor, current, bases: editBases(db, current.changes) };
  });
  return { snapshot, sha256: await commitHash(new TextEncoder().encode(JSON.stringify(snapshot))) };
}
export interface HttpWorkspaceTarget { url: string; token?: string | null; fetch?: typeof fetch; signal?: AbortSignal }
function headers(target: HttpWorkspaceTarget) {
  return { "content-type": "application/json", ...(target.token ? { authorization: `Bearer ${target.token}` } : {}) };
}
async function health(target: HttpWorkspaceTarget) {
  return withSyncBudget(async signal => {
    const res = await (target.fetch ?? fetch)(new URL("/health", target.url), { headers: headers(target), signal, cache: "no-store" });
    if (!res.ok) throw new MhError(res.status === 401 || res.status === 403 ? "auth" : "network", `工作区连接失败 (${res.status})`);
    return HealthResponseSchema.parse(await res.json());
  }, undefined, target.signal);
}
export async function inspectHttpAccess(db: DbDriver, target: HttpWorkspaceTarget): Promise<WorkspaceAccess> {
  setWorkspaceAccess(db, { url: target.url, kind: "checking" });
  try {
    const info = await health(target);
    if (!info.generation) {
      requireSupportedVersion(info.dataVersion ?? 1);
      if (readReplicaGeneration(db)) throw new MhError("conflict", "此连接不是当前 v2 工作区");
      return setWorkspaceAccess(db, { url: target.url, kind: "ready", dataVersion: info.dataVersion ?? 1 });
    }
    const state = classifyWorkspaceAccess(db, target.url, info.generation, info.dataVersion ?? 2, "http");
    observeDataVersion(db, info.generation.workspaceId, info.dataVersion ?? 2);
    if (state.kind !== "ready" && !info.capabilities?.includes(BOOTSTRAP_CAPABILITY))
      throw new MhError("busy", "请更新服务器以支持新设备接入");
    return setWorkspaceAccess(db, state);
  } catch (error) { return workspaceAccessError(db, target.url, error); }
}
export function httpWorkspaceSource(db: DbDriver, target: HttpWorkspaceTarget): WorkspaceSnapshotSource {
  return {
    async preflight() {
      const state = await inspectHttpAccess(db, target);
      if (state.kind === "error" || state.kind === "client-update") {
        requireSupportedVersion(state.dataVersion ?? 2);
        throw new MhError("busy", state.reason ?? "工作区尚未就绪");
      }
    },
    async download() {
      const info = await health(target), expected = info.generation;
      if (!expected || !info.capabilities?.includes(BOOTSTRAP_CAPABILITY)) throw new MhError("busy", "请更新服务器以支持新设备接入");
      observeDataVersion(db, expected.workspaceId, info.dataVersion ?? 2);
      const response = await withSyncBudget(async signal => {
        const res = await (target.fetch ?? fetch)(new URL(BOOTSTRAP_PATH, target.url), { method: "POST", headers: headers(target), signal, cache: "no-store",
          body: JSON.stringify({ ...dataVersionRange, workspaceId: expected.workspaceId, epoch: expected.epoch, checkpoint: expected.checkpoint }) });
        if (!res.ok) {
          const detail = await res.json().catch(() => ({})) as { code?: string; workspaceDataVersion?: number };
          if (detail.code === "client_update_required" && detail.workspaceDataVersion) observeDataVersion(db, expected.workspaceId, detail.workspaceDataVersion);
          throw new MhError(res.status === 401 || res.status === 403 ? "auth" : detail.code === "rebootstrap_required" ? "rebootstrap_required" : "network", `工作区下载失败 (${res.status})`);
        }
        const raw: unknown = await res.json();
        // Hash the received snapshot before schema parsing can reorder its keys.
        if (
          typeof raw !== "object" || raw === null ||
          !("sha256" in raw) || typeof raw.sha256 !== "string" || !("snapshot" in raw) ||
          await commitHash(new TextEncoder().encode(JSON.stringify(raw.snapshot))) !== raw.sha256
        ) {
          throw new MhError("invalid_input", "工作区快照校验失败");
        }
        return BootstrapResponseSchema.parse(raw);
      }, undefined, target.signal);
      const snapshot = response.snapshot;
      if (snapshot.generation.workspaceId !== expected.workspaceId || snapshot.generation.epoch !== expected.epoch || snapshot.generation.checkpoint !== expected.checkpoint ||
          snapshot.current.workspaceId !== expected.workspaceId || snapshot.current.epoch !== expected.epoch || snapshot.current.coveredSequence !== 0 ||
          Object.keys(snapshot.current.sourceCoverage).length || snapshot.current.pendingRecovery.length || snapshot.current.history.length || snapshot.bases.length !== snapshot.current.changes.length)
        throw new MhError("invalid_input", "HTTP snapshot identity or coverage is invalid");
      observeDataVersion(db, expected.workspaceId, snapshot.dataVersion);
      return {
        workspaceId: expected.workspaceId, epoch: expected.epoch, checkpointId: expected.checkpoint, dataVersion: snapshot.dataVersion, current: snapshot.current,
        async install(shadow, generation) {
          ingestPeerChanges(shadow, snapshot.current.changes, snapshot.bases);
          shadow.query("INSERT OR REPLACE INTO meta(key,value) VALUES('sync_v2_baseline_http',?)").run(target.url);
          shadow.query("INSERT OR REPLACE INTO meta(key,value) VALUES(?, '1')").run(`sync_verified_peer:${target.url}`);
          // Native hosts keep credentials outside SQLite and may create a
          // shadow without a connection row. Commit the captured HTTP cursor
          // even in that case, before requesting any post-snapshot changes.
          shadow.query(`INSERT INTO peers(url,kind,enabled,pull_cursor,push_cursor,node_id)
            VALUES(?,'http',1,?,(SELECT COALESCE(MAX(seq),0) FROM crdt_changes),?)
            ON CONFLICT(url) DO UPDATE SET pull_cursor=excluded.pull_cursor,
              push_cursor=excluded.push_cursor,node_id=excluded.node_id`)
            .run(target.url, snapshot.cursor, snapshot.node_id);
          // The shadow has its own incarnation; never copy the server's identity.
          assertReplicaGeneration(shadow, generation);
          let pages = 0;
          for (;;) {
            const result = await syncWithPeer(shadow, target.url, { token: target.token ?? undefined, fetch: target.fetch, signal: target.signal, pullLimit: 1000, pushLimit: 1000 });
            if ((result.received ?? 0) < 1000) break;
            if (++pages > 10_000) throw new MhError("busy", "工作区仍在更新，请重试");
          }
        },
        async verify() {
          const latest = await health(target);
          if (latest.generation?.workspaceId !== expected.workspaceId || latest.generation.epoch !== expected.epoch || latest.generation.checkpoint !== expected.checkpoint)
            throw new MhError("rebootstrap_required", "workspace changed during download");
          observeDataVersion(db, expected.workspaceId, latest.dataVersion ?? 2);
          if (target.signal?.aborted) throw target.signal.reason;
        },
      };
    },
  };
}
export function recoverHttpWorkspace(db: DbDriver, target: HttpWorkspaceTarget, adapter: RecoveryAdapter) {
  return recoverWorkspace(db, adapter, httpWorkspaceSource(db, target));
}
