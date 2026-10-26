import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBuildSourcePaths } from "./native-build-provenance";

test("source fingerprint covers untracked input changes, deletions, stable ordering and duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "mh-build-provenance-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "apps/mobile/src"), { recursive: true });
    await Bun.write(join(root, "src/tracked.ts"), "export const tracked = 1;");
    await Bun.write(join(root, "apps/mobile/src/untracked.ts"), "export const next = 1;");
    const paths = ["src/tracked.ts", "apps/mobile/src/untracked.ts", "src/deleted.ts", "src/tracked.ts"];
    const before = await hashBuildSourcePaths(root, paths);
    expect(Object.keys(before.sourceInputs)).toEqual([
      "apps/mobile/src/untracked.ts", "src/deleted.ts", "src/tracked.ts",
    ]);
    expect(before.sourceInputs["src/deleted.ts"]).toBeNull();
    expect(before.sourceInputs["apps/mobile/src/untracked.ts"]).toHaveLength(64);
    await Bun.write(join(root, "apps/mobile/src/untracked.ts"), "export const next = 2;");
    const after = await hashBuildSourcePaths(root, paths);
    expect(after.sourceSha256).not.toBe(before.sourceSha256);
    expect(after.sourceInputCount).toBe(3);
    expect((await hashBuildSourcePaths(root, paths.reverse())).sourceSha256).toBe(after.sourceSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
