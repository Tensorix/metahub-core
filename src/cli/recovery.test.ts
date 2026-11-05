import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runSchema } from "../core/db.ts";
import { recoveryItems } from "../core/sync/recovery-v2.ts";
import { getDocument } from "../core/documents.ts";

test("CLI recovery lists, restores idempotently and discards only the selected item", async () => {
  const home = mkdtempSync(join(tmpdir(),"mh-cli-recovery-"));
  try {
    const db = new Database(join(home,"metahub.db")); runSchema(db); recoveryItems(db);
    for (const id of ["keep","discard"]) db.query("INSERT INTO sync_recovery_items(id,kind,target,local,remote) VALUES(?,'document','missing',?,NULL)").run(id,JSON.stringify({ title: id, body: `${id} content` }));
    db.close();
    const command = async (...args: string[]) => {
      const proc = Bun.spawn([process.execPath,resolve(import.meta.dir,"index.ts"),"recovery",...args,"--json"],{
        env: { ...process.env, METAHUB_HOME: home, MH_OFFLINE: "1" }, stdout: "pipe", stderr: "pipe",
      });
      const [out,err,status] = await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
      expect({ status,err }).toEqual({ status: 0,err: "" }); return JSON.parse(out);
    };
    expect((await command("list")).length).toBe(2);
    const first = await command("copy","keep"), second = await command("copy","keep");
    expect(second.documentId).toBe(first.documentId);
    expect((await command("list")).map((item: { id: string }) => item.id)).toEqual(["discard"]);
    await command("discard","discard"); expect(await command("list")).toEqual([]);
    const reopened = new Database(join(home,"metahub.db"));
    try { expect(getDocument(reopened,first.documentId)?.body).toBe("keep content"); }
    finally { reopened.close(); }
  } finally { rmSync(home,{ recursive: true,force: true }); }
});
