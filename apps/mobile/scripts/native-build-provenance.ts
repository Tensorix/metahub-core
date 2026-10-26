import { join } from "node:path";

/** Hash tracked and untracked build inputs; ignored native outputs and node_modules stay excluded. */
export async function captureBuildSources(root: string) {
  const git = Bun.spawn([
    "git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
    "src", "apps/mobile", "scripts", ".github/workflows/mobile.yml",
    "package.json", "bun.lock", "bunfig.toml",
  ], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(git.stdout).text(), new Response(git.stderr).text(), git.exited,
  ]);
  if (code !== 0) throw new Error(`Cannot enumerate build sources: ${error.trim()}`);
  const paths = output.split("\0").filter(Boolean);
  if (!paths.length) throw new Error("Build source enumeration returned no inputs");
  return hashBuildSourcePaths(root, paths);
}

export async function hashBuildSourcePaths(root: string, sourcePaths: string[]) {
  const paths = [...new Set(sourcePaths)].sort();
  const sourceInputs: Record<string, string | null> = {};
  const fingerprint = new Bun.CryptoHasher("sha256");
  for (const path of paths) {
    const file = Bun.file(join(root, path));
    const digest = await file.exists()
      ? new Bun.CryptoHasher("sha256").update(await file.arrayBuffer()).digest("hex")
      : null;
    sourceInputs[path] = digest;
    fingerprint.update(path).update("\0").update(digest ?? "deleted").update("\0");
  }
  return { sourceInputs, sourceInputCount: paths.length, sourceSha256: fingerprint.digest("hex") };
}
