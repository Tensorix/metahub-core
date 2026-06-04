/**
 * Tag a DESKTOP release. Reads the version from apps/desktop/package.json,
 * creates the `desktop-v<version>` tag, and pushes it — which triggers
 * .github/workflows/release-desktop.yml (the 3-OS Electron packaging). Bump the
 * version in apps/desktop/package.json and commit on main BEFORE running this.
 *
 *   bun run release          # (from apps/desktop) tag desktop-v<version> and push
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
$.cwd(repoRoot);

const pkg = JSON.parse(
  await Bun.file(join(repoRoot, "apps/desktop/package.json")).text(),
) as { version: string };
const tag = `desktop-v${pkg.version}`;

const existing = (await $`git tag --list ${tag}`.text()).trim();
if (existing) {
  console.error(`✖ tag ${tag} already exists — bump the version in apps/desktop/package.json first.`);
  process.exit(1);
}

console.log(`▶ tagging desktop release ${tag}`);
await $`git tag ${tag}`;
await $`git push origin ${tag}`;
console.log(`✅ pushed ${tag} — GitHub Actions will package and publish the desktop release.`);
