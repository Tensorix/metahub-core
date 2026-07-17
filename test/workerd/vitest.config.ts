// vitest-pool-workers config (spike ⑦: the vitest-4 plugin API — the old
// defineWorkersConfig entrypoint no longer exists).
//
// HOW TO RUN (manual — NOT part of the `bun test` gate; workerd cannot run
// inside bun, and these deps are heavy, so this directory is its own package):
//   cd test/workerd
//   bun install
//   bun run test

import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["**/*.workerd.ts"],
  },
});
