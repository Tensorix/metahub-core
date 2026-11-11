import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Window } from "happy-dom";

async function fixture(native = false) {
  const built = await Bun.build({
    entrypoints: ["bridge-test-entry"],
    target: "browser",
    format: "iife",
    plugins: [
      {
        name: "entry",
        setup(b) {
          b.onResolve({ filter: /^bridge-test-entry$/ }, () => ({
            path: "entry",
            namespace: "test",
          }));
          b.onLoad({ filter: /.*/, namespace: "test" }, () => ({
            contents: `import * as bridge from '${import.meta.dir}/bridge.ts'; window.testBridge=bridge;`,
            loader: "ts",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new Error(String(built.logs));
  const window = new Window(),
    win = window as any,
    messages: any[] = [];
  const sandbox = Object.fromEntries(
    Object.getOwnPropertyNames(window)
      .map((key) => [key, win[key]])
      .filter(([, v]) => v !== undefined),
  );
  win.ReactNativeWebView = {
    sessionProtocol: native ? 2 : undefined,
    postMessage: (raw: string, ...extra: unknown[]) => {
      const message = JSON.parse(raw);
      expect(extra).toEqual(native ? [message.session] : []);
      messages.push(message);
    },
  };
  runInContext(
    await built.outputs[0]!.text(),
    createContext({ ...sandbox, window, document: window.document, console }),
  );
  const api = win.testBridge;
  api.beginSession({
    session: "one",
    workspace: "test",
    databaseId: "db",
    dark: false,
  });
  const reply = (m: any, ok = true, value: any = null) =>
    win.__metahubDatabaseReceive({
      session: m.session,
      id: m.id,
      ok,
      value,
      error: "write failed",
    });
  return {
    api,
    messages,
    reply,
    close: () => {
      api.endSession();
      window.happyDOM.abort();
    },
  };
}
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await Bun.sleep(2);
  }
  throw new Error("timeout");
};
test("flush coalesces, waits for writes, and does not wait for a slow query", async () => {
  const f = await fixture();
  try {
    const read = f.api.rpc("readRecordQuery", "q").catch(() => {});
    const write = f.api.rpc("updateRecord", "r", {});
    const first = f.api.flush(),
      second = f.api.flush();
    expect(first).toBe(second);
    await Bun.sleep(10);
    expect(f.messages.some((m) => m.method === "flush")).toBe(false);
    f.reply(f.messages.find((m) => m.method === "updateRecord"));
    await write;
    await until(() => f.messages.some((m) => m.method === "flush"));
    f.reply(f.messages.find((m) => m.method === "flush"));
    await first;
    f.reply(f.messages.find((m) => m.method === "readRecordQuery"));
    await read;
  } finally {
    f.close();
  }
});
test("failed save blocks flush and old responses cannot satisfy a new session", async () => {
  const f = await fixture();
  try {
    const write = f.api.rpc("updateRecord", "r", {}).catch(() => {});
    const saving = f.api.flush();
    const rejected = saving.then(
      () => {
        throw new Error("save unexpectedly succeeded");
      },
      (e: Error) => expect(e.message).toBe("write failed"),
    );
    await Bun.sleep(10);
    f.reply(
      f.messages.find((m) => m.method === "updateRecord"),
      false,
    );
    await rejected;
    await write;
    expect(f.messages.some((m) => m.method === "flush")).toBe(false);
    const old = f.api.rpc("getRecord", "old").catch(() => {}),
      oldMessage = f.messages.at(-1);
    f.api.endSession();
    await old;
    f.api.beginSession({
      session: "two",
      workspace: "test",
      databaseId: "db2",
      dark: false,
    });
    let resolved = false;
    const next = f.api.rpc("getRecord", "new").then(() => {
      resolved = true;
    });
    f.reply({ ...oldMessage, id: f.messages.at(-1).id });
    await Bun.sleep(5);
    expect(resolved).toBe(false);
    f.reply(f.messages.at(-1));
    await next;
  } finally {
    f.close();
  }
});
test("a write rejected before blur still blocks exit until an explicit successful retry", async () => {
  const f = await fixture();
  try {
    const write = f.api
      .rpc("updateDatabase", "db", { name: "new" })
      .catch(() => {});
    f.reply(f.messages.at(-1), false);
    await write;
    const result = f.api.flush().then(
      () => false,
      (e: Error) => e.message === "write failed",
    );
    await until(() => f.messages.some((m) => m.method === "flush"));
    f.reply(f.messages.find((m) => m.method === "flush"));
    expect(await result).toBe(true);
    const retry = f.api.rpc("updateDatabase", "db", { name: "new" });
    f.reply(f.messages.at(-1));
    await retry;
    const before = f.messages.length,
      next = f.api.flush();
    await until(() =>
      f.messages.slice(before).some((m) => m.method === "flush"),
    );
    f.reply(f.messages.at(-1));
    await next;
  } finally {
    f.close();
  }
});
test("only the custom iOS transport receives the explicit session argument", async () => {
  const f = await fixture(true);
  try {
    const pending = f.api.rpc("getRecord", "r");
    f.reply(f.messages.at(-1));
    await pending;
  } finally {
    f.close();
  }
});
