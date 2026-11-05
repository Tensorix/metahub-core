import { readReplicaGeneration } from "./retention-protocol.ts";
import { MhError } from "../errors.ts";
import type { RetentionReport } from "./retention-executor.ts";
import type { DbDriver } from "../driver.ts";
import type { StorageClient, S3Config } from "./storage.ts";
import { createV2Bucket } from "./bucket-v2.ts";
import { executeRetention, cleanRetiredV2Objects } from "./retention-executor.ts";
import { DAY_MS } from "./retention-state.ts";

/** Durable daily scheduling; bucket time authorizes age, local time never does.
 * Enabling requires a separately recorded review; default remains dry-run. */
export async function maintainV2Workspace(db: DbDriver, client: StorageClient, config: S3Config) {
  const bucket = createV2Bucket(client, config), root = await bucket.root();
  if (!root) return;
  const at = bucket.serverTime();
  if (at === null) return;
  const head = await bucket.log(root).read();
  const previous = db.query("SELECT value FROM meta WHERE key='sync_v2_retention_report'").get() as { value: string } | null;
  if (!head.state.preparing && previous && at - JSON.parse(previous.value).checkedAt < DAY_MS) return;
  const reviewed = db.query("SELECT value FROM meta WHERE key='sync_v2_retention_review'").get() as { value: string } | null;
  let enabled = false;
  if (reviewed) {
    try {
      const approval = JSON.parse(reviewed.value);
      enabled = approval.workspaceId === root.workspaceId && typeof approval.reviewedCheckpoint === "string";
    } catch { enabled = reviewed.value === head.state.checkpoint; }
  }
  const result = await executeRetention(db, client, config, { enabled });
  db.query("INSERT INTO meta(key,value) VALUES('sync_v2_retention_report',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ checkedAt: at, result }));
  // Same explicit review gate also applies to delayed physical cleanup.
  if (enabled) await cleanRetiredV2Objects(client, config, { enabled: true });
}

/** Call only after the displayed report has been explicitly reviewed. Approval
 * is workspace-scoped so the next checkpoint can perform delayed cleanup. */
export function approveRetentionReport(db: DbDriver, report: RetentionReport): void {
  const generation = readReplicaGeneration(db);
  if (!generation || generation.workspaceId !== report.workspaceId || generation.checkpoint !== report.checkpoint || generation.epoch !== report.epoch)
    throw new MhError("rebootstrap_required", "retention report is no longer current");
  db.query("INSERT INTO meta(key,value) VALUES('sync_v2_retention_review',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ workspaceId: report.workspaceId, reviewedCheckpoint: report.checkpoint, observedAt: report.observedAt, candidates: report.candidates.length }));
  db.query("DELETE FROM meta WHERE key='sync_v2_retention_report'").run();
}
