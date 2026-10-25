/** Disposable loopback server for native transport acceptance. Never uses the user's hub. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.METAHUB_HOME = mkdtempSync(join(tmpdir(), "mh-native-acceptance-"));
const { startServer } = await import("../../../src/core/sync/server.ts");
const { webuiRoutes, webuiOnStart } = await import("../../../src/webui/server/routes.ts");
const server = startServer({ port: 8991, host: "127.0.0.1", token: "native-acceptance-local-only", autoSync: false, ui: { routes: webuiRoutes, onStart: webuiOnStart, serveAssets: async () => null } });
console.log(JSON.stringify({ port: server.port, home: process.env.METAHUB_HOME }));
process.on("SIGINT", () => { server.stop(); process.exit(0); });
