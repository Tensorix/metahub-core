import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { dataMap } from "../../core/sync/data-map-db.ts";
import type { DataMapState, DataPlace } from "../../core/data-map.ts";
import { print, table, guard } from "../output.ts";

const rel = (ms: number | null, now: number): string => {
  if (ms == null) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const FRESHNESS: Record<DataPlace["freshness"], string> = {
  live: "live (this device)",
  current: "current (acknowledged)",
  behind: "BEHIND",
  stale: "STALE",
  error: "ERROR",
  never: "never synced",
  disabled: "disabled",
};

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/** Head line + issue lines + tip, from the map alone. Pure for tests.
 *  - With several concurrent problems the head names the winner and points at
 *    the list, so precedence never MASKS anything.
 *  - The tip matches the actual failure: a failing target needs its config
 *    checked — telling the user to `mh sync` a known-broken peer is noise. */
export function statusHead(
  map: { state: DataMapState },
  now: number,
): { head: string; issueLines: string[]; tip: string | null } {
  const { state } = map;
  const head =
    state.state === "no_backup"
      ? "Data exists ONLY on this device — no sync target configured (add one: `mh config`)."
      : state.state === "pending_blobs"
        ? `Data in ${state.places} place(s), but ${state.pendingBlobCount} blob(s) (${mb(state.pendingBlobBytes)} MB) exist only here — not yet flushed to a durable anchor.`
        : state.state === "unsynced_changes"
          ? `Current version is confirmed in ${state.places} place(s), but one or more enabled targets have not acknowledged it.`
          : state.state === "peer_error"
            ? `Data in ${state.places} place(s) — a sync target is FAILING (see below).`
            : state.state === "syncing"
              ? `Data in ${state.places} place(s); first sync to a configured target has not completed yet.`
              : state.state === "stale"
                ? `Current version is acknowledged in ${state.places} place(s), but the confirmation is stale.`
                : `Data in ${state.places} place(s); oldest copy synced ${rel(state.oldestSyncedAt, now)}.`;
  const issueLines =
    state.issues.length > 1
      ? state.issues.map(
          (i) =>
            `! ${i.placeLabel ? `${i.placeLabel}: ` : ""}${i.kind}${i.message ? ` — ${i.message}` : ""}`,
        )
      : [];
  const hasError = state.issues.some((i) => i.kind === "peer_error");
  const hasSyncable = state.issues.some(
    (i) => i.kind === "behind" || i.kind === "stale" || i.kind === "pending_blobs",
  );
  const tip =
    state.state === "healthy" || state.state === "no_backup"
      ? null
      : hasError
        ? "(a target keeps failing — check its credentials/endpoint: `mh config show`; `mh sync` retries it)"
        : hasSyncable || state.state === "unsynced_changes" || state.state === "syncing"
          ? "(run `mh sync` to sync now)"
          : "(run `mh sync` to sync now)";
  return { head, issueLines, tip };
}

export default defineCommand({
  meta: {
    name: "status",
    description:
      "Where the workspace's data lives and how fresh each copy is (read-only, offline)",
  },
  run: guard(() => {
    const db = openMetahub();
    const map = dataMap(db);
    print(map, () => {
      const now = Date.now();
      const { head, issueLines, tip } = statusHead(map, now);
      const rows = map.places.map((p) => ({
        place: p.label,
        kind: p.kind,
        freshness:
          FRESHNESS[p.freshness] +
          (p.syncedAt != null ? ` (${rel(p.syncedAt, now)})` : "") +
          (p.lag > 0 ? "; current version unacknowledged" : ""),
        roles: p.roles.join(","),
        error: p.error ?? "",
      }));
      return (
        `${head}\n\n${table(rows)}` +
        (issueLines.length ? "\n" + issueLines.join("\n") : "") +
        (tip ? `\n${tip}` : "")
      );
    });
  }),
});
