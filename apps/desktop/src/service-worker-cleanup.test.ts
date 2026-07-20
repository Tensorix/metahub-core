import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  quarantineLegacyServiceWorkerStorage,
  removeQuarantinedServiceWorkerStorage,
} from "./service-worker-cleanup";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function profile(): string {
  const root = mkdtempSync(join(tmpdir(), "metahub-desktop-sw-"));
  roots.push(root);
  return root;
}

test("quarantines only legacy Service Worker storage and keeps profile data", async () => {
  const root = profile();
  const sw = join(root, "Service Worker");
  mkdirSync(join(sw, "Database"), { recursive: true });
  writeFileSync(join(sw, "Database", "CURRENT"), "MANIFEST-000001");
  writeFileSync(join(root, "quicknote-settings.json"), '{"shortcut":"test"}');
  mkdirSync(join(root, "Local Storage"), { recursive: true });
  writeFileSync(join(root, "Local Storage", "data"), "keep");

  const result = quarantineLegacyServiceWorkerStorage(root, "test");

  expect(result.migrated).toBe(true);
  expect(result.warning).toBeUndefined();
  expect(existsSync(sw)).toBe(false);
  expect(result.quarantined).toHaveLength(1);
  expect(existsSync(join(result.quarantined[0]!, "Database", "CURRENT"))).toBe(true);
  expect(existsSync(join(root, "quicknote-settings.json"))).toBe(true);
  expect(existsSync(join(root, "Local Storage", "data"))).toBe(true);

  expect(await removeQuarantinedServiceWorkerStorage(result.quarantined)).toEqual([]);
  expect(existsSync(result.quarantined[0]!)).toBe(false);
});

test("cleanup marker prevents later desktop cache directories from being removed", () => {
  const root = profile();
  mkdirSync(join(root, "Service Worker"), { recursive: true });
  const first = quarantineLegacyServiceWorkerStorage(root, "first");
  expect(first.migrated).toBe(true);

  // Chromium may create a new, empty directory later. It is not legacy state
  // and must not be detached on every launch.
  mkdirSync(join(root, "Service Worker"), { recursive: true });
  writeFileSync(join(root, "Service Worker", "new"), "keep");
  const second = quarantineLegacyServiceWorkerStorage(root, "second");

  expect(second.migrated).toBe(false);
  expect(existsSync(join(root, "Service Worker", "new"))).toBe(true);
  expect(second.quarantined).toEqual(first.quarantined);
});
