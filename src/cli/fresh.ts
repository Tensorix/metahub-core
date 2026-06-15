import { openMetahub } from "../core/db.ts";
import { ensureFresh } from "../core/sync/peers.ts";

// Shared freshness gate for CLI *read* commands (②b). A CLI read is non-reactive:
// it reads the local DB once and exits, with no background poll and no revalidate.
// So before reading we re-pull when the local DB is very stale (see ensureFresh).
// With a running daemon this is a near-instant no-op; it only does real work on a
// daemon-less node that hasn't synced in a while.

/** citty args to opt out of (`--offline`) or force (`--fresh`) the pre-read sync. */
export const FRESH_ARGS = {
  offline: { type: "boolean", description: "Read local data only — skip the staleness re-sync" },
  fresh: { type: "boolean", description: "Force a sync before reading (ignore the staleness window)" },
} as const;

/** Open the hub, then re-pull if the local DB is very stale. Returns the db. */
export async function freshDb(args: { offline?: boolean; fresh?: boolean }) {
  const db = openMetahub();
  await ensureFresh(db, { offline: args.offline, force: args.fresh });
  return db;
}
