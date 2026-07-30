import { defineCommand } from "citty";
import { openMetahub } from "../../core/db.ts";
import { syncWithPeer, type SyncResult } from "../../core/sync/client.ts";
import { addPeer, listPeers, syncAllPeers } from "../../core/sync/peers.ts";
import { syncFiles } from "../../core/sync/files.ts";
import { errorCode, MhError } from "../../core/errors.ts";
import { print, guard, markExitCode } from "../output.ts";

const isTTY = () => Boolean(process.stdout.isTTY && process.stdin.isTTY);

/**
 * Peer sync with a graceful token flow: an already-paired peer (or --token)
 * syncs straight through; otherwise a token-gated server returns 401 and we
 * prompt for the token (on a TTY), retry, and remember it so the next sync is
 * direct. Non-interactive callers get a clear error telling them to pass --token.
 */
async function peerSync(
  db: ReturnType<typeof openMetahub>,
  url: string,
  token: string | undefined,
): Promise<SyncResult> {
  try {
    const result = await syncWithPeer(db, url, token);
    if (token) addPeer(db, { url, token }); // remember an explicitly-passed token
    return result;
  } catch (e) {
    if (token || errorCode(e) !== "auth") throw e;
    if (!isTTY()) {
      throw new MhError(
        "auth",
        `${(e as Error).message}\nthis server requires a token — pass --token <token> or run in an interactive terminal`,
      );
    }
    const entered = (globalThis.prompt("this server requires a token — enter it:") ?? "").trim();
    if (!entered) throw new MhError("auth", "no token provided");
    const result = await syncWithPeer(db, url, entered);
    addPeer(db, { url, token: entered }); // save so future syncs are direct
    return result;
  }
}

export default defineCommand({
  meta: {
    name: "sync",
    description:
      "Sync now: no args = one round against every configured peer; sync <url> = one server; sync <src> <dst> = export/import a doc or table file",
  },
  args: {
    src: {
      type: "positional",
      required: false,
      description:
        "Server URL (peer sync) — or a doc/table ref or file path (file sync). Omit to sync all configured peers",
    },
    dst: {
      type: "positional",
      required: false,
      description: "File path or entity ref; when given, export/import instead of peer sync",
    },
    token: {
      type: "string",
      description: "Auth token for a protected sync server (saved for next time)",
    },
  },
  run: guard(async (args) => {
    const db = openMetahub();
    if (args.src == null) {
      // Daily-driver form: one round against every enabled peer (buckets + servers).
      if (!listPeers(db).some((p) => p.enabled))
        throw new MhError(
          "invalid_input",
          "no sync targets configured — connect one first:\n  mh config backup connect   (cloud bucket)\n  mh config device add       (pair a device)",
        );
      const results = await syncAllPeers(db);
      print(results, () =>
        results
          .map((r) =>
            r.ok
              ? `${r.url}: pushed ${r.pushed}, pulled ${r.pulled}` +
                (r.warnings?.length ? `\n  warning: ${r.warnings.join("\n  warning: ")}` : "")
              : `${r.url}: error — ${r.error}`,
          )
          .join("\n"),
      );
      // Warnings (channel maintenance) never affect the exit code — only a
      // failed data sync is a network error.
      if (results.some((r) => !r.ok)) markExitCode("network");
      return;
    }
    if (args.dst == null) {
      const result = await peerSync(db, args.src, args.token);
      return print(result, () => `pushed ${result.pushed}, pulled ${result.pulled}`);
    }
    const r = await syncFiles(db, args.src, args.dst);
    print(
      r,
      () => `${r.direction} ${r.kind} ${r.id} ${r.direction === "export" ? "→" : "←"} ${r.path}`,
    );
  }),
});
