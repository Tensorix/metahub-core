/**
 * Pure, dependency-free helpers for the core auto-updater. Kept separate from
 * core-updater.ts (which imports electron) so they can be unit-tested under a
 * plain `bun test`.
 */

/** Release asset name for this platform — matches build-sidecars.ts output. */
export function sidecarAssetName(): string {
  const { platform, arch } = process;
  if (platform === "darwin") {
    if (arch === "arm64") return "metahub-sidecar-mac-arm64";
    if (arch === "x64") return "metahub-sidecar-mac-x64";
  } else if (platform === "win32") {
    if (arch === "arm64") return "metahub-sidecar-win-arm64.exe";
    if (arch === "x64") return "metahub-sidecar-win-x64.exe";
  } else if (platform === "linux") {
    if (arch === "arm64") return "metahub-sidecar-linux-arm64";
    if (arch === "x64") return "metahub-sidecar-linux-x64";
  }
  throw new Error(`unsupported platform for core auto-update: ${platform}/${arch}`);
}

export const tagToVersion = (tag: string): string => tag.replace(/^v/, "");

/** Compare `major.minor.patch` (ignoring any prerelease suffix). -1 | 0 | 1. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (s: string) =>
    s
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** Parse `"<sha>  <name>"` lines (sha256sum output) into a name→sha map. */
export function parseSha256Sums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m) map.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return map;
}
