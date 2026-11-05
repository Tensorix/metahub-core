import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { MhError } from "../../core/errors.ts";
import { recoveryItems, resolveRecoveryItem } from "../../core/sync/recovery-v2.ts";
import { inspectRetention } from "../../core/sync/retention-executor.ts";
import { approveRetentionReport } from "../../core/sync/v2-maintenance.ts";
import { listPeers } from "../../core/sync/peers.ts";
import { storageClientFor, type S3Config } from "../../core/sync/storage.ts";
import { guard, print } from "../output.ts";

export default defineCommand({
  meta: { name: "recovery", description: "Review preserved edits and the v2 retention report" },
  args: {
    action: { type: "positional", required: false, default: "list", description: "list | copy | discard | report | approve" },
    id: { type: "positional", required: false, description: "Recovery item ID, or reviewed checkpoint hash for approve" },
    peer: { type: "string", description: "Bucket peer URL when more than one is configured" },
  },
  run: guard(async args => {
    const db = openMetahub();
    try {
      if (args.action === "list") return print(recoveryItems(db));
      if (args.action === "copy" || args.action === "discard") {
        if (!args.id) throw new MhError("invalid_input", "a recovery item ID is required");
        return print({ id: args.id, action: args.action, documentId: resolveRecoveryItem(db,args.id,args.action) });
      }
      if (args.action !== "report" && args.action !== "approve") throw new MhError("invalid_input", "use recovery list, copy, discard, report or approve");
      const peers = listPeers(db).filter(peer => peer.enabled && peer.kind === "s3" && (!args.peer || peer.url === args.peer));
      if (peers.length !== 1) throw new MhError("invalid_input", "select exactly one configured bucket with --peer");
      const config: S3Config = JSON.parse(peers[0]!.config!);
      const report = await inspectRetention(db,storageClientFor(config),config);
      if (args.action === "report") return print(report);
      if (args.id !== report.checkpoint) throw new MhError("invalid_input", "review recovery report, then pass its exact checkpoint hash to recovery approve");
      approveRetentionReport(db,report);
      print({ approved: true, workspaceId: report.workspaceId, checkpoint: report.checkpoint });
    } finally { db.close(); }
  }),
});
