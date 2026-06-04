/**
 * Tag a CORE release. Reads the version from the root package.json, creates the
 * `v<version>` tag, and pushes it — which triggers .github/workflows/release.yml
 * (CLI binaries + sidecar binaries + checksums). Bump the version in
 * package.json and commit on main BEFORE running this.
 *
 *   bun run release          # tag v<version> and push
 */
import { $ } from "bun";

const pkg = JSON.parse(await Bun.file("package.json").text()) as { version: string };
const tag = `v${pkg.version}`;

const existing = (await $`git tag --list ${tag}`.text()).trim();
if (existing) {
  console.error(`✖ tag ${tag} already exists — bump the version in package.json first.`);
  process.exit(1);
}

console.log(`▶ tagging core release ${tag}`);
await $`git tag ${tag}`;
await $`git push origin ${tag}`;
console.log(`✅ pushed ${tag} — GitHub Actions will build and publish the release.`);
