import type { Database } from "bun:sqlite";
import { resolveRef } from "../core/resolve.ts";
import { getCurrentDatabase } from "../core/context.ts";
import { fail } from "./output.ts";

/** Resolve a database ref; when omitted, fall back to the current database. */
export function resolveDb(db: Database, ref: string | undefined): string {
  if (ref != null) return resolveRef(db, ref, { kind: "db" });
  const cur = getCurrentDatabase(db);
  if (!cur) fail("no current database; pass <db> or run `mh use <db>`");
  return cur.id;
}
