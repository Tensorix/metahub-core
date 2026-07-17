import type { DbDriver } from "../core/driver.ts";
import { getServerConfig } from "../core/config.ts";

/** This node's own reachable base URL for links it serves (share links, site URLs). */
export function localServerBase(db: DbDriver): string {
  const cfg = getServerConfig(db);
  const host = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host;
  return `http://${host}:${cfg.port}`;
}
