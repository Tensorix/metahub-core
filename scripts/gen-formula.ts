/**
 * Generate the Homebrew **formula** for the CLI (`metahub-cli`) from a published
 * core GitHub release. The core release ships `SHA256SUMS.txt`, so this just
 * reads the published checksums (no binary downloads) and writes a formula that
 * installs the prebuilt `metahub-<platform>` binary as `mh` (+ a `metahub`
 * alias). The `url`s are the public browser download URLs.
 *
 *   bun run scripts/gen-formula.ts <core-tag> [outFile]   # omit → stdout
 *   bun run scripts/gen-formula.ts v0.1.4 Formula/metahub-cli.rb
 *
 * Requires `gh` authenticated (locally) or GH_TOKEN (CI).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const REPO = "Tensorix/metahub-core";

const tag = process.argv[2];
const outFile = process.argv[3];
if (!tag) {
  console.error("usage: gen-formula.ts <core-tag> [outFile]");
  process.exit(1);
}
const version = tag.replace(/^v/, "");

// The four CLI binaries Homebrew installs, mapped to formula platform blocks.
const binaries = {
  macArm: "metahub-darwin-arm64",
  macIntel: "metahub-darwin-x64",
  linuxArm: "metahub-linux-arm64",
  linuxIntel: "metahub-linux-x64",
} as const;

// Download the published checksums (small) and parse `"<sha>  <name>"` lines.
const dir = await mkdtemp(join(tmpdir(), "metahub-formula-"));
let sums: Map<string, string>;
try {
  await $`gh release download ${tag} --repo ${REPO} --pattern SHA256SUMS.txt --dir ${dir} --clobber`.quiet();
  const text = await readFile(join(dir, "SHA256SUMS.txt"), "utf8");
  sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m) sums.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

const sha = (name: string): string => {
  const s = sums.get(name);
  if (!s) throw new Error(`no checksum for ${name} in ${tag}/SHA256SUMS.txt`);
  return s;
};
const url = (name: string): string =>
  `https://github.com/${REPO}/releases/download/${tag}/${name}`;

const formula = `class MetahubCli < Formula
  desc "Local-first typed knowledge base with CRDT sync for AI agents (CLI)"
  homepage "https://github.com/${REPO}"
  version "${version}"

  on_macos do
    on_arm do
      url "${url(binaries.macArm)}"
      sha256 "${sha(binaries.macArm)}"
    end
    on_intel do
      url "${url(binaries.macIntel)}"
      sha256 "${sha(binaries.macIntel)}"
    end
  end

  on_linux do
    on_arm do
      url "${url(binaries.linuxArm)}"
      sha256 "${sha(binaries.linuxArm)}"
    end
    on_intel do
      url "${url(binaries.linuxIntel)}"
      sha256 "${sha(binaries.linuxIntel)}"
    end
  end

  def install
    # The release asset is a single self-contained binary; install it as \`mh\`
    # with a \`metahub\` alias (both bins the package.json declares).
    bin.install Dir["metahub-*"].first => "mh"
    bin.install_symlink "mh" => "metahub"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/mh --version")
  end
end
`;

if (outFile) {
  await Bun.write(outFile, formula);
  console.error(`✅ wrote ${outFile} (metahub-cli ${version})`);
} else {
  console.log(formula);
}
