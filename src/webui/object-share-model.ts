import type { ShareListItem } from "./api.ts";
import { EXPIRY } from "./share-modal-model.ts";

export const SNAPSHOT_MAX_AGE = 604_800_000;
/** Signed snapshot URLs cannot be permanent. Keep duration, not array index. */
export function objectShareExpiry(snapshot: boolean, duration: number | null) {
  return snapshot
    ? Math.min(duration ?? SNAPSHOT_MAX_AGE, SNAPSHOT_MAX_AGE)
    : duration;
}
export function objectShareExpiryOptions(snapshot: boolean) {
  return EXPIRY.filter(
    (option) =>
      !snapshot || (option.ms != null && option.ms <= SNAPSHOT_MAX_AGE),
  );
}
export function objectShareState(share: ShareListItem, now = Date.now()) {
  if (share.lifecycle === "cleanup_pending") return "revoking";
  if (share.lifecycle === "provisioning") return "creating";
  if (share.expiresAt != null && share.expiresAt <= now) return "expired";
  // A snapshot without a signed-link expiry has no usable access link.
  if (share.transport === "s3" && share.expiresAt == null) return "expired";
  return "active";
}
