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
import { mkdir, readFile, writeFile, rename, rm, chmod, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
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
const FETCH_TIMEOUT_MS = 10_000;

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

/** Remove any leftover `*.tmp` from an interrupted previous download. */
async function sweepStaleTmp(dir: string): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (name.endsWith(".tmp")) await rm(join(dir, name), { force: true });
    }
  } catch {
    /* dir may not exist yet */
  }
}

/**
 * Download the platform sidecar for `release`, verify its SHA-256, and atomically
 * install it into the cache. Returns the written metadata. Throws on any failure
 * (caller swallows); a thrown error always leaves the previous binary intact.
 */
async function downloadAndStage(release: GhRelease, signal?: AbortSignal): Promise<CoreVersionMeta> {
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

  const tmpPath = join(dir, `${assetName}.tmp`);
  try {
    const binRes = await fetch(asset.browser_download_url, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });
    if (!binRes.ok) throw new Error(`download failed (${binRes.status})`);
    const bytes = Buffer.from(await binRes.arrayBuffer());

    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`checksum mismatch for ${assetName}`);
    }
    await writeFile(tmpPath, bytes);

    if (process.platform !== "win32") await chmod(tmpPath, 0o755);
    await stripQuarantine(tmpPath);

    await rename(tmpPath, cachedBinaryPath()); // atomic within the same dir

    const meta: CoreVersionMeta = {
      version: tagToVersion(release.tag_name),
      sha256: expected.toLowerCase(),
      installedAt: new Date().toISOString(),
    };
    const metaTmp = `${metaPath()}.tmp`;
    await writeFile(metaTmp, JSON.stringify(meta, null, 2));
    await rename(metaTmp, metaPath());
    return meta;
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

// ---- orchestrator ----------------------------------------------------------

/**
 * Check for and stage a newer core sidecar. Never throws; applies on next
 * launch. Returns the new version if one was staged, else null.
 */
export async function maybeUpdateCore(): Promise<string | null> {
  try {
    const signal = timeoutSignal(FETCH_TIMEOUT_MS);
    const release = await fetchLatestCoreRelease(signal);
    if (!release) return null;

    const installed = await getInstalledCoreVersion();
    const latest = tagToVersion(release.tag_name);
    if (compareSemver(latest, installed) <= 0) {
      console.log(`[core-updater] up to date (installed ${installed}, latest ${latest})`);
      return null;
    }

    console.log(`[core-updater] updating core ${installed} → ${latest}`);
    const meta = await downloadAndStage(release, signal);
    console.log(`[core-updater] staged core ${meta.version}; applies on next launch`);
    return meta.version;
  } catch (err) {
    console.warn(`[core-updater] update skipped: ${(err as Error).message}`);
    return null;
  }
}
