import { defineCommand, runMain } from "citty";
import pkg from "../../package.json" with { type: "json" };
import init from "./commands/init.ts";
import db from "./commands/db.ts";
import prop from "./commands/prop.ts";
import record from "./commands/record.ts";
import doc from "./commands/doc.ts";
import edit from "./commands/edit.ts";
import search from "./commands/search.ts";
import sync from "./commands/sync.ts";
import { startServer } from "../core/sync/server.ts";
import { print } from "./output.ts";

const main = defineCommand({
  meta: {
    name: "metahub",
    version: pkg.version,
    description: pkg.description ?? "",
  },
  args: {
    server: { type: "boolean", description: "Start the CRDT sync server" },
    port: { type: "string", description: "Server port (with --server)", default: "7777" },
  },
  subCommands: {
    init,
    db,
    prop,
    record,
    doc,
    edit,
    search,
    sync,
  },
});

// `mh --server [--port N]` is a root flag, handled before citty (which would
// otherwise treat the port value as a subcommand name).
function parsePort(argv: string[]): number {
  const i = argv.findIndex((a) => a === "--port" || a.startsWith("--port="));
  if (i < 0) return 7777;
  const a = argv[i]!;
  return Number(a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1]) || 7777;
}

const argv = process.argv.slice(2);
if (argv.includes("--server")) {
  const s = startServer({ port: parsePort(argv) });
  print({ server: "listening", port: s.port, nodeId: s.node }, () =>
    `metahub sync server on :${s.port} (node ${s.node})`,
  );
} else {
  runMain(main);
}
