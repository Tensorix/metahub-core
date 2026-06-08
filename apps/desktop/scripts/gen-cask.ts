/**
 * Generate the Homebrew **cask** for the desktop app (`metahub-app`) from a
 * published desktop GitHub release. Discovers the arm64 + intel `.dmg` assets,
 * downloads them via `gh` (works even while the repo is private), SHA256-hashes
 * them, and writes a `metahub-app.rb` cask whose `url`s are the public browser
 * download URLs (what end users fetch once the repo is public).
 *
 *   bun run scripts/gen-cask.ts <desktop-tag> [outFile]   # omit → stdout
 *   bun run scripts/gen-cask.ts desktop-v0.1.0 Casks/metahub-app.rb
 *
 * Requires `gh` authenticated (locally) or GH_TOKEN (CI).
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const REPO = "Tensorix/metahub-core";

const tag = process.argv[2];
const outFile = process.argv[3];
if (!tag) {
  console.error("usage: gen-cask.ts <desktop-tag> [outFile]");
  process.exit(1);
}
const version = tag.replace(/^desktop-v/, "");

interface Asset {
  name: string;
  url: string; // gh's `.url` on a release asset is the public browser download URL
}

const assets: Asset[] = JSON.parse(
  await $`gh release view ${tag} --repo ${REPO} --json assets --jq .assets`.text(),
);

// Match the .dmg whose filename version matches the tag exactly. A release can
// carry stale assets from an earlier build (e.g. both Metahub-0.1.0-*.dmg and
// Metahub-0.1.1-*.dmg) — picking the first arch match would silently grab the
// wrong version, so require the tag's version in the name and fail loudly if a
// build for this tag never made it to the release.
const allDmgs = assets.filter((a) => a.name.toLowerCase().endsWith(".dmg"));
const dmgs = allDmgs.filter((a) => a.name.includes(`-${version}-`));
const armDmg = dmgs.find((a) => /arm64/i.test(a.name));
const intelDmg = dmgs.find((a) => !/arm64/i.test(a.name));
if (!armDmg || !intelDmg) {
  throw new Error(
    `expected an arm64 and an intel .dmg for version ${version} in ${tag}; ` +
      `matched: ${dmgs.map((d) => d.name).join(", ") || "none"} ` +
      `(all .dmg assets: ${allDmgs.map((d) => d.name).join(", ") || "none"}). ` +
      `If a different version is present, the build for ${tag} did not produce ` +
      `version ${version} — rebuild/re-upload before regenerating the cask.`,
  );
}

/** Download via the authenticated gh asset endpoint (private-repo safe) and hash. */
async function sha256OfAsset(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metahub-cask-"));
  try {
    await $`gh release download ${tag} --repo ${REPO} --pattern ${name} --dir ${dir} --clobber`.quiet();
    return createHash("sha256").update(await readFile(join(dir, name))).digest("hex");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.error(`▶ hashing ${armDmg.name} + ${intelDmg.name} …`);
const armSha = await sha256OfAsset(armDmg.name);
const intelSha = await sha256OfAsset(intelDmg.name);

const cask = `cask "metahub-app" do
  version "${version}"

  on_arm do
    sha256 "${armSha}"
    url "${armDmg.url}"
  end
  on_intel do
    sha256 "${intelSha}"
    url "${intelDmg.url}"
  end

  name "Metahub"
  desc "Local-first typed knowledge base with CRDT sync for AI agents (desktop app)"
  homepage "https://github.com/Tensorix/metahub-core"

  app "Metahub.app"

  # Unsigned, by design (open-source — no Apple Developer signing). macOS would
  # otherwise flag the freshly installed .app as "damaged" (the quarantine
  # attribute on an unsigned, un-notarized bundle). Strip it on install so the
  # app opens on first launch without a Gatekeeper detour.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Metahub.app"]
  end

  zap trash: [
    "~/Library/Application Support/Metahub",
    "~/Library/Preferences/org.tensorix.metahub.plist",
    "~/Library/Saved Application State/org.tensorix.metahub.savedState",
  ]
end
`;

if (outFile) {
  await Bun.write(outFile, cask);
  console.error(`✅ wrote ${outFile} (metahub-app ${version})`);
} else {
  console.log(cask);
}
