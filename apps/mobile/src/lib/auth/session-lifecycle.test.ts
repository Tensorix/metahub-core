import { expect, test } from "bun:test";
import { findWorkspaceStack, replaceSession, shouldResetSessionNavigation } from "./session-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const events: string[] = [];
  const errors: unknown[] = [];
  const old = {
    id: 1, workspaceId: "workspace-a",
    activate() { events.push("activate-old"); },
    async dispose() { events.push("dispose-old"); },
  };
  const current = { current: old as typeof old | null };
  const next = {
    ...old, id: 2,
    activate() { expect(current.current).toBe(next); events.push("activate-next"); },
    async dispose() { events.push("dispose-next"); },
  };
  const published: (typeof old | null)[] = [];
  const options = {
    current,
    valid: () => true,
    publish(session: typeof old | null) {
      expect(current.current).toBe(session);
      published.push(session); events.push("publish");
    },
    onCleanupError: (error: unknown) => { errors.push(error); },
  };
  return { old, next, options, current, events, errors, published };
}

test("reauth prepares while old callbacks remain current, then adopts without signing out", async () => {
  const f = fixture(), prepared = deferred<typeof f.next>();
  const result = replaceSession({ ...f.options, prepare: () => prepared.promise });
  expect(f.current.current).toBe(f.old);
  expect(f.events).toEqual([]);
  prepared.resolve(f.next);
  expect(await result).toBe(true);
  expect(f.published).toEqual([f.next]);
  expect(f.events).toEqual(["publish", "activate-next", "dispose-old"]);
  expect(f.current.current).not.toBe(f.old);
});
test("failed preparation retains the old workspace and its drafts", async () => {
  const f = fixture();
  await expect(replaceSession({ ...f.options, prepare: async () => { throw new Error("open failed"); } })).rejects.toThrow("open failed");
  expect(f.current.current).toBe(f.old);
  expect(f.published).toEqual([]);
  expect(f.events).toEqual([]);
});
test("an obsolete preparation is closed without activation or publication", async () => {
  const f = fixture(), prepared = deferred<typeof f.next>();
  let generation = 1;
  const captured = generation;
  const result = replaceSession({ ...f.options, prepare: () => prepared.promise, valid: () => generation === captured });
  generation++;
  prepared.resolve(f.next);
  expect(await result).toBe(false);
  expect(f.current.current).toBe(f.old);
  expect(f.published).toEqual([]);
  expect(f.events).toEqual(["dispose-next"]);
});
test("retiring old resources cannot dispose or roll back the adopted workspace", async () => {
  const f = fixture(), retired = deferred<void>();
  f.old.dispose = async () => { f.events.push("dispose-old"); await retired.promise; };
  const result = replaceSession({ ...f.options, prepare: async () => f.next });
  await Bun.sleep(0);
  expect(f.current.current).toBe(f.next);
  expect(f.published).toEqual([f.next]);
  expect(f.events).toEqual(["publish", "activate-next", "dispose-old"]);
  retired.resolve(); await result;
  expect(f.events).not.toContain("dispose-next");
});
test("transport startup and retirement errors retain the new offline workspace", async () => {
  const f = fixture();
  f.next.activate = () => { throw new Error("network startup"); };
  f.old.dispose = async () => { throw new Error("retire failed"); };
  expect(await replaceSession({ ...f.options, prepare: async () => f.next })).toBe(true);
  expect(f.current.current).toBe(f.next);
  expect(f.errors).toHaveLength(2);
  expect(f.published).toEqual([f.next]);
});
test("a real disconnect publishes signed-out once and closes the old session", async () => {
  const f = fixture();
  expect(await replaceSession({ ...f.options, prepare: async () => null })).toBe(true);
  expect(f.current.current).toBeNull();
  expect(f.published).toEqual([null]);
  expect(f.events).toEqual(["publish", "dispose-old"]);
});
const old = { id: 1, workspaceId: "a" }, reauth = { id: 2, workspaceId: "a" }, other = { id: 3, workspaceId: "b" };
test("hydration, same-workspace reauth, and token renewals preserve navigation", () => {
  expect(shouldResetSessionNavigation(undefined, old, "doc/[id]")).toBe(false);
  expect(shouldResetSessionNavigation(old, reauth, "(tabs)")).toBe(false);
  expect(shouldResetSessionNavigation(old, old, "connect")).toBe(false);
  expect(shouldResetSessionNavigation(old, reauth, "record/[id]")).toBe(false);
});
test("workspace changes and completed connection routes reset old private history", () => {
  expect(shouldResetSessionNavigation(old, other, "doc/[id]")).toBe(true);
  expect(shouldResetSessionNavigation(old, reauth, "add-server")).toBe(true);
  expect(shouldResetSessionNavigation(null, old, "connect")).toBe(true);
});
test("Protected routes exclusively own first onboarding login and final logout", () => {
  expect(shouldResetSessionNavigation(null, old, "onboarding/index")).toBe(false);
  expect(shouldResetSessionNavigation(null, old, "onboarding/scan")).toBe(false);
  expect(shouldResetSessionNavigation(old, null, "(tabs)")).toBe(false);
});
test("workspace navigation targets the app Stack inside SDK 57's internal root", () => {
  const app = { key: "app-stack", index: 1, routeNames: ["(tabs)", "add-server", "connect"], routes: [{ name: "(tabs)" }, { name: "add-server" }] };
  const root = { key: "expo-root", index: 0, routeNames: ["__root", "+not-found"], routes: [{ name: "__root", state: app }] };
  const target = findWorkspaceStack(root);
  expect(target).toBe(app);
  expect(target?.routes[target.index ?? 0]?.name).toBe("add-server");
  expect(findWorkspaceStack(app)).toBe(app);
  expect(findWorkspaceStack({ ...root, routes: [{ name: "__root" }] })).toBeUndefined();
  expect(findWorkspaceStack(undefined)).toBeUndefined();
});
test("unmount while retiring the old transport prevents later credential persistence", async () => {
  const f = fixture(), retired = deferred<void>();
  let mounted = true;
  f.old.dispose = async () => { await retired.promise; };
  const result = replaceSession({ ...f.options, prepare: async () => f.next, valid: () => mounted });
  await Bun.sleep(0);
  expect(f.current.current).toBe(f.next);
  mounted = false;
  f.current.current = null;
  await f.next.dispose(); retired.resolve();
  expect(await result).toBe(false);
  expect(f.current.current).toBeNull();
  expect(f.events.filter((event) => event === "dispose-next")).toHaveLength(1);
});
