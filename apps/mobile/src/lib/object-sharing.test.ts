import type { Session } from "./auth/session";
import { test, expect, mock } from "bun:test";
mock.module("expo-file-system", () => ({
  File: class {
    async bytes() {
      return new Uint8Array();
    }
  },
}));
mock.module("expo-crypto", () => ({ randomUUID: () => crypto.randomUUID() }));
const { objectSharing } = await import("./object-sharing");
function fixture() {
  const events: string[] = [],
    requests: any[] = [];
  let current = true,
    fail = false;
  const session = {
    creds: {},
    sync: {
      status: { connected: true, pendingPush: 0, syncing: false, error: null },
    },
    replica: { db: {} },
    isCurrent: () => current,
    syncNow: async () => {
      events.push("sync");
      if (fail) throw Error("offline");
    },
    api: {
      req: async (method: string, path: string, body?: unknown) => {
        events.push("request");
        requests.push({ method, path, body });
        return {
          slug: "test",
          url: "https://example.test/share/test",
          expiresAt: null,
        };
      },
    },
  } as unknown as Session;
  return {
    session,
    service: objectSharing(session, "doc", "doc_test"),
    events,
    requests,
    expire: () => {
      current = false;
    },
    fail: () => {
      fail = true;
    },
  };
}
test("server share is read-only and waits for sync before creation", async () => {
  const f = fixture();
  await f.service.create("secret", 7);
  expect(f.events).toEqual(["sync", "request"]);
  expect(f.requests[0].body).toMatchObject({
    kind: "doc",
    ref: "doc_test",
    permission: "view",
    expiresMs: 604800000,
    password: "secret",
  });
  expect(f.requests[0].body.requestId).toBeTruthy();
});
test("failed sync never publishes a stale document", async () => {
  const f = fixture();
  f.fail();
  await expect(f.service.create("", 7)).rejects.toThrow("offline");
  expect(f.requests).toHaveLength(0);
});
test("a resolved sync with queued writes still blocks publication", async () => {
  const f = fixture();
  f.session.sync.status.pendingPush = 3;
  await expect(f.service.create("", 7)).rejects.toThrow("尚未同步");
  expect(f.requests).toHaveLength(0);
});
test("retired workspace cannot list, publish, or revoke shares", async () => {
  const f = fixture();
  f.expire();
  await expect(f.service.list()).rejects.toThrow("会话");
  await expect(f.service.create("", 7)).rejects.toThrow("会话");
  await expect(
    f.service.revoke({ slug: "test", expiresAt: null, hasPassword: false }),
  ).rejects.toThrow("会话");
  expect(f.events).toHaveLength(0);
});
test("expired server link cannot be sent to another app", async () => {
  const f = fixture();
  await expect(
    f.service.url({
      slug: "old",
      url: "https://example.test/old",
      expiresAt: 1,
      hasPassword: false,
    }),
  ).rejects.toThrow("过期");
});
test("copy active link does not publish another share", async () => {
  const f = fixture();
  expect(
    await f.service.url({
      slug: "test",
      url: "https://example.test/share/test",
      expiresAt: null,
      hasPassword: false,
    }),
  ).toBe("https://example.test/share/test");
  expect(f.requests).toHaveLength(0);
});
