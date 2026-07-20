import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const CLEANUP_VERSION = 1;
const MARKER_NAME = `.metahub-service-worker-cleanup-v${CLEANUP_VERSION}`;
const QUARANTINE_PREFIX = `.metahub-service-worker-stale-v${CLEANUP_VERSION}-`;

export interface ServiceWorkerCleanup {
  /** True when this launch detached Chromium's legacy Service Worker directory. */
  migrated: boolean;
  /** Detached directories that are safe to remove after Electron starts. */
  quarantined: string[];
  /** Best-effort cleanup failure; startup may continue and retry next launch. */
  warning?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findQuarantined(userData: string): string[] {
  try {
    return readdirSync(userData)
      .filter((name) => name.startsWith(QUARANTINE_PREFIX))
      .map((name) => join(userData, name));
  } catch {
    return [];
  }
}

/**
 * Detach Service Worker storage left by older desktop releases before Chromium
 * opens the profile.
 *
 * The sidecar uses a random localhost port on every launch, so old releases
 * accumulated one Service Worker origin per port. A renderer can only remove
 * registrations for its current origin; moving the profile directory here is
 * the only reliable way to clear all of those stale origins at once.
 *
 * Only Chromium's "Service Worker" cache directory is moved. LocalStorage,
 * IndexedDB, cookies, MetaHub data, and desktop preferences are untouched.
 */
export function quarantineLegacyServiceWorkerStorage(
  userData: string,
  nonce = `${Date.now()}-${process.pid}`,
): ServiceWorkerCleanup {
  const marker = join(userData, MARKER_NAME);
  const alreadyQuarantined = findQuarantined(userData);
  if (existsSync(marker)) {
    return { migrated: false, quarantined: alreadyQuarantined };
  }

  try {
    mkdirSync(userData, { recursive: true });
    const serviceWorkerDir = join(userData, "Service Worker");
    const quarantined = [...alreadyQuarantined];
    if (existsSync(serviceWorkerDir)) {
      const detached = join(userData, `${QUARANTINE_PREFIX}${nonce}`);
      renameSync(serviceWorkerDir, detached);
      quarantined.push(detached);
    }
    writeFileSync(
      marker,
      JSON.stringify({ version: CLEANUP_VERSION, completedAt: new Date().toISOString() }),
      "utf8",
    );
    return { migrated: true, quarantined };
  } catch (error) {
    // Do not create the marker on failure: the next launch gets another chance
    // before Chromium opens the profile.
    return {
      migrated: false,
      quarantined: findQuarantined(userData),
      warning: errorMessage(error),
    };
  }
}

/** Remove detached cache directories without delaying the first window. */
export async function removeQuarantinedServiceWorkerStorage(paths: string[]): Promise<string[]> {
  const failures: string[] = [];
  await Promise.all(
    [...new Set(paths)].map(async (path) => {
      try {
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        failures.push(`${path}: ${errorMessage(error)}`);
      }
    }),
  );
  return failures;
}
