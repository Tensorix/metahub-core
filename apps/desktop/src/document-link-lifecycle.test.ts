import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test.each(["mac", "argv", "booting", "loading", "warm", "closed", "secondary", "dev"])(
  "desktop protocol lifecycle: %s",
  async (scenario) => {
    const child = Bun.spawn([
      process.execPath,
      fileURLToPath(new URL("./fixtures/document-link-lifecycle.ts", import.meta.url)),
      scenario,
    ], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, errors: exitCode === 0 ? "" : stdout + stderr }).toEqual({ exitCode: 0, errors: "" });
  },
);
