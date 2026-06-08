/**
 * Smoke-test that a *compiled* CLI binary can actually serve `/webui.js`.
 *
 * This guards the failure mode that shipped a 500 to production: the compiled
 * binary has no source tree and no sibling dist/webui.js, so unless the WebUI
 * bundle is embedded at build time (src/cli/compiled-entry.ts → setWebuiBundle),
 * `/webui.js` throws and 500s. `bun test` can't catch this — it runs from source
 * and hits the Bun.build() fallback, never the embedded path a binary takes.
 *
 * Run standalone: `bun run scripts/smoke-webui.ts <path-to-binary>`
 * Or import and call smokeWebui(binaryPath) from the build script.
 */
import { spawn } from "node:child_process";

/** Throws if the binary doesn't serve a non-empty JS bundle at /webui.js. */
export async function smokeWebui(binaryPath: string): Promise<void> {
  // Bind 127.0.0.1:0 → OS picks a free port; we parse it from the startup banner.
  // --debug disables auth so the GET needs no token.
  const proc = spawn(binaryPath, ["--server", "--host", "127.0.0.1", "--port", "0", "--debug"], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  try {
    const port = await waitForPort(proc);
    const res = await fetch(`http://127.0.0.1:${port}/webui.js`);
    if (res.status !== 200) {
      throw new Error(`/webui.js → ${res.status} (expected 200): ${await res.text()}`);
    }
    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("javascript")) {
      throw new Error(`/webui.js content-type "${ctype}" is not javascript`);
    }
    const body = await res.text();
    if (body.length === 0) throw new Error("/webui.js body is empty");
    console.log(`✅ webui smoke ok (${(body.length / 1024).toFixed(0)}KB) — ${binaryPath}`);
  } finally {
    proc.kill("SIGKILL");
  }
}

/** Resolve the listening port from the server's stdout, or reject on early exit/timeout. */
function waitForPort(proc: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server did not start within 10s\n${out}`)), 10_000);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      proc.stdout?.removeAllListeners("data");
      fn();
    };
    proc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      // Banner prints the URL, e.g. http://localhost:54321 / http://127.0.0.1:54321
      const m = out.match(/https?:\/\/[^\s]*?:(\d+)/);
      if (m) done(() => resolve(Number(m[1])));
    });
    proc.on("exit", (code) => done(() => reject(new Error(`server exited early (code ${code})\n${out}`))));
    proc.on("error", (err) => done(() => reject(err)));
  });
}

if (import.meta.main) {
  const binaryPath = process.argv[2];
  if (!binaryPath) {
    console.error("usage: bun run scripts/smoke-webui.ts <path-to-binary>");
    process.exit(1);
  }
  await smokeWebui(binaryPath);
}
