/**
 * Post-build guard: boot a freshly compiled binary as a loopback server and
 * assert the version it ACTUALLY self-reports (GET /docs.json → info.version)
 * matches the version in the root package.json.
 *
 * Catches the "version bumped after the binary was compiled" release bug: every
 * binary bakes in `pkg.version` at `bun build --compile` time, so a binary built
 * before a version bump silently self-reports the OLD version under the NEW
 * release tag. Downstream that strands the desktop auto-updater on a permanent
 * "restart pending" loop (installed/tagged version > running/self-reported one).
 *
 * Cross-compiled targets can't run on the build host, so callers verify only the
 * host-native binary — and since every target compiles from the same
 * package.json in one build, the host binary is a faithful proxy for the set.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The `bun --compile --target` value matching the current build host. */
export function hostBunTarget(): string {
  const plat = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `bun-${plat}-${arch}`;
}

interface VerifyOpts {
  /** Version the binary must self-report (root package.json version). */
  expected: string;
  /**
   * The CLI binary (`mh --server`) and the desktop sidecar announce their bound
   * port on stdout differently, and take different args to start serving.
   */
  kind: "cli" | "sidecar";
}

// The CLI prints its listening JSON (`{"server":"listening","port":N,...}`) when
// piped; the sidecar prints the `METAHUB_PORT=N` contract line (see sidecar.ts).
const PORT_RE = { cli: /"port":\s*(\d+)/, sidecar: /METAHUB_PORT=(\d+)/ } as const;
const ARGS: Record<VerifyOpts["kind"], string[]> = {
  cli: ["--server", "--debug", "--port", "0", "--json"], // port 0 → OS picks a free one
  sidecar: [], // server-bundle.ts always runs the sidecar; args are ignored
};

const PORT_TIMEOUT_MS = 20_000;

export async function verifyBinaryVersion(binPath: string, opts: VerifyOpts): Promise<void> {
  // Isolate the throwaway server's data dir so verification never touches a real
  // metahub in the build user's home.
  const home = await mkdtemp(join(tmpdir(), "mh-verify-"));
  const child = spawn(binPath, ARGS[opts.kind], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for the server to announce a port")),
        PORT_TIMEOUT_MS,
      );
      const onData = (chunk: Buffer): void => {
        const m = chunk.toString().match(PORT_RE[opts.kind]);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`binary exited (code ${code}) before announcing a port`));
      });
      child.on("error", reject);
    });

    const res = await fetch(`http://127.0.0.1:${port}/docs.json`);
    if (!res.ok) throw new Error(`/docs.json returned ${res.status}`);
    const reported = ((await res.json()) as { info?: { version?: string } }).info?.version;
    if (reported !== opts.expected) {
      throw new Error(
        `version self-check failed for ${binPath}: binary self-reports "${reported}", but ` +
          `package.json is "${opts.expected}". The binary was compiled before the version ` +
          `bump — rebuild from current source before releasing.`,
      );
    }
    console.log(`✓ ${binPath} self-reports ${reported}`);
  } finally {
    child.kill("SIGTERM");
    await rm(home, { recursive: true, force: true });
  }
}
