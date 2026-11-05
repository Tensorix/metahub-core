import { test, expect } from "bun:test";
import { freezeAndFlushEditors, registerRecoveryEditor } from "./recovery-barrier";

test("recovery freezes every mounted editor before flushing and retains freeze until released", async () => {
  const session = {}, events: string[] = [];
  for (const id of ["a","b"]) registerRecoveryEditor(session,() => ({
    setFrozen: value => { events.push(`${id}:${value}`); },
    flush: async () => { events.push(`${id}:flush`); return { ok: true }; },
  }));
  const release = await freezeAndFlushEditors(session);
  expect(events).toEqual(["a:true","b:true","a:flush","b:flush"]);
  release(); expect(events.slice(-2)).toEqual(["a:false","b:false"]);
});
test("flush failure aborts protection and unfreezes all editors", async () => {
  const session = {}, events: boolean[] = [];
  const unregister = registerRecoveryEditor(session,() => ({
    setFrozen: value => { events.push(value); }, flush: async () => ({ ok: false,error: "disk full" }),
  }));
  await expect(freezeAndFlushEditors(session)).rejects.toThrow("disk full");
  expect(events).toEqual([true,false]);
  unregister(); await freezeAndFlushEditors(session);
});
