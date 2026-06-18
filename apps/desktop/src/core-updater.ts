/**
 * Auto-updates the core "sidecar" binary from GitHub Releases.
 *
 * The desktop shell (this Electron app) and the core (CLI + sync server) ship
 * on independent cadences. The packaged app embeds one sidecar as an offline
 * fallback (electron-builder extraResources → `process.resourcesPath`), but on
 * every launch we check GitHub for a newer core release and, if found, download
 * the matching sidecar into the user-data cache. `main.ts` prefers the cached
 * binary, so the update takes effect on the NEXT launch — we never hot-swap a
 * running sidecar.
 *
 * The app is unsigned (open-source, no Apple Developer signing). A binary
 * fetched programmatically (this `fetch`, not a browser) is NOT quarantined by
 * macOS, so it can be spawned directly; we still strip any quarantine attribute
 * defensively. Integrity is verified against the release's SHA256SUMS file.
 *
 * Runs in the Electron main process (Node). Every public entry point swallows
 * its own errors: a failed/aborted update must never block startup.
 */
import { app } from "electron";
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, chmod, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_CORE_VERSION } from "./core-version";
import { compareSemver, parseSha256Sums, sidecarAssetName, tagToVersion } from "./version-util";

const REPO = "Tensorix/metahub-core";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;
/** Core release tags look like `v0.1.4`; this excludes `desktop-v*`. */
const CORE_TAG_RE = /^v\d+\.\d+\.\d+/;
/** Must match exactly what the core release workflow uploads (see release.yml). */
const SHA256SUMS_ASSET = "SHA256SUMS-sidecars.txt";
const USER_AGENT = "metahub-desktop-updater";
/** Short budget for the GitHub API call (small JSON). */
const API_TIMEOUT_MS = 10_000;
/**
 * Generous budget for the actual sidecar download (~64 MB) + checksum file.
 * Must NOT share the API budget: on a slow link, a 10 s cap aborts the binary
 * download every time, silently skipping the update and stranding the client.
 */
const DOWNLOAD_TIMEOUT_MS = 180_000;

interface CoreVersionMeta {
  version: string;
  sha256: string;
  installedAt: string;
}
interface GhAsset {
  name: string;
  browser_download_url: string;
}
interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GhAsset[];
}

// ---- paths -----------------------------------------------------------------

function coreDir(): string {
  return join(app.getPath("userData"), "core");
}

/** Launch name `main.ts` looks for — the downloaded asset is renamed to this. */
function cachedBinaryFileName(): string {
  return process.platform === "win32" ? "metahub-sidecar.exe" : "metahub-sidecar";
}

export function cachedBinaryPath(): string {
  return join(coreDir(), cachedBinaryFileName());
}

function metaPath(): string {
  return join(coreDir(), "version.json");
}

// ---- version helpers -------------------------------------------------------

/** Best-effort: the cached core version, else the version bundled at build. */
export async function getInstalledCoreVersion(): Promise<string> {
  try {
    const raw = await readFile(metaPath(), "utf8");
    const meta = JSON.parse(raw) as CoreVersionMeta;
    if (meta && typeof meta.version === "string") return meta.version;
  } catch {
    /* no cache yet, or corrupt — fall through */
  }
  return BUNDLED_CORE_VERSION;
}

// ---- GitHub ----------------------------------------------------------------

function timeoutSignal(ms: number): AbortSignal {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms).unref?.();
  return ctrl.signal;
}

/** Latest non-draft CORE release (`v*`, not `desktop-v*`), or null on any issue. */
export async function fetchLatestCoreRelease(signal?: AbortSignal): Promise<GhRelease | null> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
      signal,
    });
    if (!res.ok) return null; // includes 403/429 rate limiting
    const all = (await res.json()) as GhRelease[];
    const core = all
      .filter((r) => !r.draft && !r.prerelease && CORE_TAG_RE.test(r.tag_name))
      .sort((a, b) => compareSemver(b.tag_name, a.tag_name));
    return core[0] ?? null;
  } catch {
    return null; // offline / DNS / abort
  }
}

// ---- download + stage ------------------------------------------------------

async function stripQuarantine(path: string): Promise<void> {
  if (process.platform !== "darwin") return;
  await new Promise<void>((resolve) => {
    const p = spawn("xattr", ["-dr", "com.apple.quarantine", path], { stdio: "ignore" });
    p.on("error", () => resolve()); // xattr missing → ignore
    p.on("exit", () => resolve()); // attribute may be absent → ignore non-zero
  });
}

/** Remove any leftover staging files/dirs from an interrupted previous download. */
async function sweepStaleTmp(dir: string): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (name.endsWith(".tmp") || name.startsWith("stage-")) {
        await rm(join(dir, name), { recursive: true, force: true });
      }
    }
  } catch {
    /* dir may not exist yet */
  }
}

/**
 * Boot a staged sidecar binary on a throwaway data dir and read the version it
 * ACTUALLY self-reports (GET /docs.json → info.version). The release's tag name
 * is not trustworthy on its own: a tag can be (re)pushed onto a commit whose
 * version was not bumped, so CI publishes a binary whose real version differs
 * from the tag. Recording the tag in that case strands the updater forever
 * (installed == tag, so it never re-downloads the corrected asset). We verify
 * the real version here so a mislabeled asset is rejected, not enshrined.
 */
async function reportedVersion(binPath: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "mh-core-verify-"));
  const child = spawn(binPath, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  try {
    // Contract with sidecar.ts: the bound port is printed as `METAHUB_PORT=<n>`.
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out reading sidecar port")), 20_000);
      const onData = (chunk: Buffer): void => {
        const m = chunk.toString().match(/METAHUB_PORT=(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`sidecar exited (code ${code}) before announcing a port`));
      });
      child.on("error", reject);
    });
    const res = await fetch(`http://127.0.0.1:${port}/docs.json`);
    if (!res.ok) throw new Error(`/docs.json returned ${res.status}`);
    const v = ((await res.json()) as { info?: { version?: string } }).info?.version;
    if (!v) throw new Error("sidecar /docs.json missing info.version");
    return v;
  } finally {
    child.kill();
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Download the platform sidecar for `release`, verify its SHA-256, and atomically
 * install it into the cache. Returns the written metadata. Throws on any failure
 * (caller swallows); a thrown error always leaves the previous binary intact.
 */
async function downloadAndStage(
  release: GhRelease,
  signal?: AbortSignal,
  onProgress?: (received: number, total: number) => void,
): Promise<CoreVersionMeta> {
  const dir = coreDir();
  await mkdir(dir, { recursive: true });
  await sweepStaleTmp(dir);

  const assetName = sidecarAssetName();
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) throw new Error(`release ${release.tag_name} has no asset ${assetName}`);
  const sumsAsset = release.assets.find((a) => a.name === SHA256SUMS_ASSET);
  if (!sumsAsset) throw new Error(`release ${release.tag_name} has no ${SHA256SUMS_ASSET}`);

  // Expected hash first — refuse to download if we can't verify.
  const sumsRes = await fetch(sumsAsset.browser_download_url, {
    headers: { "User-Agent": USER_AGENT },
    signal,
  });
  if (!sumsRes.ok) throw new Error(`failed to fetch checksums (${sumsRes.status})`);
  const expected = parseSha256Sums(await sumsRes.text()).get(assetName);
  if (!expected) throw new Error(`no checksum for ${assetName}`);

  // Stage into a throwaway subdir (same filesystem as the cache, so the final
  // promote is an atomic rename) with the real launch filename — so the binary
  // is executable as-is on every platform and a prior good cache stays intact
  // until the new one is proven good.
  const stageDir = await mkdtemp(join(dir, "stage-"));
  const stagedBin = join(stageDir, cachedBinaryFileName());
  try {
    const binRes = await fetch(asset.browser_download_url, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });
    if (!binRes.ok) throw new Error(`download failed (${binRes.status})`);
    // Stream the body so we can report download progress (the asset is ~64 MB).
    // Falls back to a single arrayBuffer read if the body isn't a stream.
    let bytes: Buffer;
    if (binRes.body) {
      const total = Number(binRes.headers.get("content-length")) || 0;
      const reader = binRes.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        // Progress reporting is best-effort — a failing reporter (e.g. IPC to a
        // closed window) must never abort an otherwise-valid download and trip
        // the finally that wipes the staging dir.
        try {
          onProgress?.(received, total);
        } catch {
          // ignore — keep downloading
        }
      }
      bytes = Buffer.concat(chunks);
    } else {
      bytes = Buffer.from(await binRes.arrayBuffer());
    }

    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`checksum mismatch for ${assetName}`);
    }
    await writeFile(stagedBin, bytes);

    if (process.platform !== "win32") await chmod(stagedBin, 0o755);
    await stripQuarantine(stagedBin);

    // Trust the binary, not the tag: record what it actually self-reports, and
    // reject an asset whose real version disagrees with the tag (a mislabeled
    // release) rather than caching a permanent restart-pending mismatch.
    const tagVersion = tagToVersion(release.tag_name);
    const realVersion = await reportedVersion(stagedBin);
    if (realVersion !== tagVersion) {
      throw new Error(
        `release ${release.tag_name} asset ${assetName} self-reports ${realVersion}, ` +
          `not ${tagVersion} — refusing to stage a mislabeled core binary`,
      );
    }

    await rename(stagedBin, cachedBinaryPath()); // atomic within the same fs

    const meta: CoreVersionMeta = {
      version: realVersion,
      sha256: expected.toLowerCase(),
      installedAt: new Date().toISOString(),
    };
    const metaTmp = `${metaPath()}.tmp`;
    await writeFile(metaTmp, JSON.stringify(meta, null, 2));
    await rename(metaTmp, metaPath());
    return meta;
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

// ---- orchestrator ----------------------------------------------------------

/**
 * Check for and stage a newer core sidecar. Never throws; applies on next
 * launch. Returns the new version if one was staged, else null.
 */
export async function maybeUpdateCore(
  onProgress?: (received: number, total: number) => void,
): Promise<string | null> {
  try {
    const release = await fetchLatestCoreRelease(timeoutSignal(API_TIMEOUT_MS));
    if (!release) return null;

    const installed = await getInstalledCoreVersion();
    const latest = tagToVersion(release.tag_name);
    if (compareSemver(latest, installed) <= 0) {
      console.log(`[core-updater] up to date (installed ${installed}, latest ${latest})`);
      return null;
    }

    console.log(`[core-updater] updating core ${installed} → ${latest}`);
    // Fresh, generous budget for the ~64 MB download — not the API budget.
    const meta = await downloadAndStage(release, timeoutSignal(DOWNLOAD_TIMEOUT_MS), onProgress);
    console.log(`[core-updater] staged core ${meta.version}; applies on next launch`);
    return meta.version;
  } catch (err) {
    console.warn(`[core-updater] update skipped: ${(err as Error).message}`);
    return null;
  }
}
