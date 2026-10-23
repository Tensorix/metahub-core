import { expect, test } from "bun:test";
import { createAuthTransport } from "./transport";
import { createClient } from "../../../../../src/sdk/client.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("SDK reads and writes share a single renewal with history/stream transport", async () => {
  const renewal = deferred<Response>();
  const calls: { url: string; token: string | null; method?: string }[] = [];
  let renewals = 0;
  const adopted: string[] = [];
  const auth = createAuthTransport("https://server", "old", {
    onToken: (token) => adopted.push(token),
    fetch: async (url, init) => {
      const token = new Headers(init?.headers).get("authorization");
      calls.push({ url, token, method: init?.method });
      if (url.endsWith("/auth/token")) {
        renewals++;
        return renewal.promise;
      }
      return token === "Bearer old" ? json({}, 401) : json([]);
    },
  });
  const client = createClient({
    baseUrl: "https://server",
    token: "old",
    fetch: auth.fetchUrl,
  });
  const read = client.listRecords("db");
  const write = client.updateRecord("row", { name: "new" });
  const stream = auth.fetchUrl("https://server/api/changes");
  // Allow SDK manifest's resolved null promise and both 401s to advance.
  await Bun.sleep(0);
  expect(renewals).toBe(1);
  renewal.resolve(json({ token: "fresh" }));
  await Promise.all([read, write, stream]);
  expect(adopted).toEqual(["fresh"]);
  expect(calls.filter((c) => c.token === "Bearer fresh")).toHaveLength(3);
  expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
  await client.listDatabases();
  expect(renewals).toBe(1);
  expect(calls.at(-1)?.token).toBe("Bearer fresh");
});

test("a late 401 reuses the rotated token without another renewal", async () => {
  const late = deferred<Response>();
  let renewals = 0;
  let first = true;
  const auth = createAuthTransport("https://a", "old", {
    fetch: async (url) => {
      if (url.endsWith("/auth/token")) {
        renewals++;
        return json({ token: "new" });
      }
      if (first) {
        first = false;
        return late.promise;
      }
      return json({});
    },
  });
  const pending = auth.fetchUrl("https://a/api/record");
  await auth.renew();
  late.resolve(json({}, 401));
  expect((await pending).ok).toBe(true);
  expect(renewals).toBe(1);
});

test("a disposed session cannot adopt late renewal or retry a write", async () => {
  const late = deferred<Response>();
  let adopted = 0;
  let calls = 0;
  const auth = createAuthTransport("https://a", "old", {
    onToken: () => {
      adopted++;
    },
    fetch: async (url) => {
      calls++;
      return url.endsWith("/auth/token") ? late.promise : json({}, 401);
    },
  });
  const pending = auth.fetchUrl("https://a/api/record", {
    method: "PATCH",
    body: "{}",
  });
  await Bun.sleep(0);
  auth.dispose();
  late.resolve(json({ token: "late" }));
  await expect(pending).rejects.toThrow("Session ended");
  expect(adopted).toBe(0);
  expect(calls).toBe(2);
});

test("invalid credentials notify once and do not renew endlessly", async () => {
  let calls = 0;
  let invalid = 0;
  const auth = createAuthTransport("https://a", "dead", {
    onInvalid: () => {
      invalid++;
    },
    fetch: async () => {
      calls++;
      return json({}, 401);
    },
  });
  expect((await auth.fetchUrl("https://a/api/version")).status).toBe(401);
  await auth.fetchUrl("https://a/api/records");
  await auth.renew();
  expect(calls).toBe(2);
  expect(invalid).toBe(1);
});

test("renewal transport failure keeps credentials recoverable", async () => {
  let invalid = 0;
  const auth = createAuthTransport("https://a", "old", {
    onInvalid: () => {
      invalid++;
    },
    fetch: async (url) => {
      if (url.endsWith("/auth/token")) throw new Error("offline");
      return json({}, 401);
    },
  });
  expect((await auth.fetchUrl("https://a/api/version")).status).toBe(401);
  expect(invalid).toBe(0);
});

test("retry is bounded to one even if the rotated credential is rejected", async () => {
  let calls = 0;
  let invalid = 0;
  const auth = createAuthTransport("https://a", "old", {
    onInvalid: () => {
      invalid++;
    },
    fetch: async (url) => {
      calls++;
      return url.endsWith("/auth/token")
        ? json({ token: "new" })
        : json({}, 401);
    },
  });
  expect((await auth.fetchUrl("https://a/api/record")).status).toBe(401);
  expect(calls).toBe(3);
  expect(invalid).toBe(1);
});

test("credentials never reach a different origin", async () => {
  let calls = 0;
  const auth = createAuthTransport("https://a", "secret", {
    fetch: async () => {
      calls++;
      return json({});
    },
  });
  await expect(auth.fetchUrl("https://a.evil/api/version")).rejects.toThrow(
    "Cross-origin",
  );
  await expect(auth.fetchUrl("https://a:444/api/version")).rejects.toThrow(
    "Cross-origin",
  );
  expect(calls).toBe(0);
});

test("a session disposed while its retry is in flight cannot return old-server data", async () => {
  const retried = deferred<Response>();
  const started = deferred<void>();
  let dataCalls = 0;
  const auth = createAuthTransport("https://a", "old", {
    fetch: async (url) => {
      if (url.endsWith("/auth/token")) return json({ token: "new" });
      if (++dataCalls === 1) return json({}, 401);
      started.resolve();
      return retried.promise;
    },
  });
  const pending = auth.fetchUrl("https://a/api/record");
  await started.promise;
  auth.dispose();
  retried.resolve(json({ secret: "old-server-data" }));
  await expect(pending).rejects.toThrow("Session ended");
});
