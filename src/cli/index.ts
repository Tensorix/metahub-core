import { defineCommand, runMain } from "citty";
import pkg from "../../package.json" with { type: "json" };
import init from "./commands/init.ts";
import db from "./commands/db.ts";
import use from "./commands/use.ts";
import get from "./commands/get.ts";
import prop from "./commands/prop.ts";
import record from "./commands/record.ts";
import doc from "./commands/doc.ts";
import edit from "./commands/edit.ts";
import search from "./commands/search.ts";
import site from "./commands/site.ts";
import completion, { complete } from "./commands/completion.ts";
import sync from "./commands/sync.ts";
import snapshot from "./commands/snapshot.ts";
import restore from "./commands/restore.ts";
import { startServer } from "../core/sync/server.ts";
import { print } from "./output.ts";
import { showUsage } from "./help.ts";

const main = defineCommand({
  meta: {
    name: "metahub",
    version: pkg.version,
    description: pkg.description ?? "",
  },
  args: {
    server: { type: "boolean", description: "Start the CRDT sync server" },
    port: { type: "string", description: "Server port (with --server)", default: "7777" },
    host: { type: "string", description: "Bind address (with --server)", default: "127.0.0.1" },
    debug: { type: "boolean", description: "Disable auth on the server (with --server)" },
    token: { type: "string", description: "Server auth token; generated if omitted (with --server)" },
  },
  subCommands: {
    init,
    db,
    use,
    get,
    prop,
    record,
    doc,
    edit,
    search,
    site,
    completion,
    __complete: complete,
    sync,
    snapshot,
    restore,
  },
});

// `mh --server [--port N ...]` is a root flag, handled before citty (which would
// otherwise treat flag values as subcommand names).
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = argv[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
}

function parsePort(argv: string[]): number {
  return Number(flagValue(argv, "port")) || 7777;
}

const argv = process.argv.slice(2);
if (argv.includes("--server")) {
  const s = startServer({
    port: parsePort(argv),
    host: flagValue(argv, "host"),
    debug: argv.includes("--debug"),
    token: flagValue(argv, "token") ?? process.env.METAHUB_TOKEN,
  });
  print(
    { server: "listening", port: s.port, nodeId: s.node, docs: `/docs`, token: s.token },
    () =>
      `metahub sync server on :${s.port} (node ${s.node}) — docs at http://localhost:${s.port}/docs\n` +
      (s.token ? `auth token: ${s.token}` : `auth: disabled (--debug)`),
  );
} else {
  runMain(main, { showUsage });
}
