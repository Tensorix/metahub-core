import { defineCommand, runMain } from "citty";
import pkg from "../../package.json" with { type: "json" };
import "../core/sync/storage-s3-bun.ts"; // side effect: register the Bun S3 storage-sync client
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
import share from "./commands/share.ts";
import token from "./commands/token.ts";
import completion, { complete } from "./commands/completion.ts";
import sync from "./commands/sync.ts";
import snapshot from "./commands/snapshot.ts";
import restore from "./commands/restore.ts";
import doctor from "./commands/doctor.ts";
import repair from "./commands/repair.ts";
import compact from "./commands/compact.ts";
import cache from "./commands/cache.ts";
import blob from "./commands/blob.ts";
import config from "./commands/config.ts";
import { parseDuration } from "../core/sync/token.ts";
import { startServer } from "../core/sync/server.ts";
import { errorCode } from "../core/errors.ts";
import { serveWebui, warmWebui } from "../webui/server/assets.ts";
import { webuiRoutes } from "../webui/server/routes.ts";
import { print, fail } from "./output.ts";
import { renderStartupBanner } from "./banner.ts";
import { resolveEndpoints } from "./netaddr.ts";
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
    "sync-interval": { type: "string", description: "Auto-sync interval, e.g. 30s/5m (with --server)" },
    "no-auto-sync": { type: "boolean", description: "Disable the auto-sync timer (with --server)" },
    "tls-cert": { type: "string", description: "TLS certificate PEM path — serve https directly (with --server)" },
    "tls-key": { type: "string", description: "TLS private key PEM path (with --server)" },
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
    share,
    token,
    completion,
    __complete: complete,
    sync,
    snapshot,
    restore,
    doctor,
    repair,
    compact,
    cache,
    blob,
    config,
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

const argv = process.argv.slice(2);
if (argv.includes("--server")) {
  // Pass a flag only when present; startServer falls back to persisted config
  // (mh config) then built-in defaults, so explicit flags keep top priority.
  const portFlag = flagValue(argv, "port");
  const intervalFlag = flagValue(argv, "sync-interval");
  const tlsCert = flagValue(argv, "tls-cert");
  const tlsKey = flagValue(argv, "tls-key");
  if ((tlsCert == null) !== (tlsKey == null)) {
    fail("--tls-cert and --tls-key must be provided together", 2);
  }
  let s: ReturnType<typeof startServer>;
  try {
    s = startServer({
      port: portFlag != null ? Number(portFlag) : undefined,
      host: flagValue(argv, "host"),
      debug: argv.includes("--debug"),
      token: flagValue(argv, "token") ?? process.env.METAHUB_TOKEN,
      syncIntervalMs: intervalFlag != null ? parseDuration(intervalFlag, 30_000) : undefined,
      autoSync: argv.includes("--no-auto-sync") ? false : undefined,
      tls: tlsCert != null && tlsKey != null ? { certPath: tlsCert, keyPath: tlsKey } : undefined,
      // Core ships no UI; the CLI server is what plugs the browser WebUI in.
      ui: { serveAssets: serveWebui, routes: webuiRoutes },
    });
    void warmWebui(); // move the first dev Bun.build off the first paint
  } catch (e) {
    // A clean one-line message + exit 1 instead of Bun's bind stack trace.
    fail(e instanceof Error ? e.message : String(e), errorCode(e) ?? 1);
  }
  // Reachable base URLs (synchronous: enumerates real NIC addresses only, no
  // network probe). Loopback bind → just localhost; wildcard/explicit → + LAN/public.
  const endpoints = resolveEndpoints(s.host, s.port, undefined, s.tls ? "https" : "http");
  const webui = endpoints[0]!.url; // localhost is always first
  const docs = `${webui}/docs`;
  print(
    {
      server: "listening",
      port: s.port,
      host: s.host,
      nodeId: s.node,
      docs: `/docs`,
      webui,
      addresses: endpoints,
      authMode: s.authMode,
      token: s.token,
      exp: s.exp != null && Number.isFinite(s.exp) ? s.exp : null,
      autoSync: s.autoSync,
      syncIntervalMs: s.syncIntervalMs,
    },
    () =>
      renderStartupBanner({
        version: pkg.version,
        host: s.host,
        port: s.port,
        endpoints,
        docsUrl: docs,
        authMode: s.authMode,
        token: s.token,
        exp: s.exp,
        node: s.node,
        autoSync: s.autoSync,
        syncIntervalMs: s.syncIntervalMs,
      }),
  );
} else {
  runMain(main, { showUsage });
}
