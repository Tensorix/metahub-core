import { test, expect } from "bun:test";
import {
  objectShareExpiry,
  objectShareExpiryOptions,
  objectShareState,
  SNAPSHOT_MAX_AGE,
} from "./object-share-model.ts";
import type { ShareListItem } from "./api.ts";

test("snapshot expiry always matches a signed URL's finite lifetime", () => {
  expect(objectShareExpiry(true, null)).toBe(SNAPSHOT_MAX_AGE);
  expect(objectShareExpiry(true, 30 * 86400000)).toBe(SNAPSHOT_MAX_AGE);
  expect(objectShareExpiry(true, 3600000)).toBe(3600000);
  expect(objectShareExpiry(false, null)).toBeNull();
  expect(
    objectShareExpiryOptions(true).every(
      (item) => item.ms != null && item.ms <= SNAPSHOT_MAX_AGE,
    ),
  ).toBe(true);
});
test("expiry doesn't hide a pending revocation or advertise provisioning as ready", () => {
  const share = { transport: "s3", expiresAt: 10 } as ShareListItem;
  expect(objectShareState(share, 11)).toBe("expired");
  expect(objectShareState({ ...share, lifecycle: "cleanup_pending" }, 11)).toBe(
    "revoking",
  );
  expect(objectShareState({ ...share, lifecycle: "provisioning" }, 11)).toBe(
    "creating",
  );
  expect(objectShareState({ ...share, expiresAt: null }, 11)).toBe("expired");
  expect(
    objectShareState({ ...share, transport: "server", expiresAt: null }, 11),
  ).toBe("active");
});
