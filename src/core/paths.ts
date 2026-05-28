import { homedir } from "node:os";
import { join } from "node:path";

export function metahubHome(): string {
  return process.env.METAHUB_HOME ?? join(homedir(), ".metahub");
}

export function dbPath(): string {
  return join(metahubHome(), "metahub.db");
}

export function cacheDir(): string {
  return join(metahubHome(), "cache");
}
