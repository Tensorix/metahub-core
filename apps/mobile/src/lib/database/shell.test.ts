import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Window } from "happy-dom";
import { Database } from "bun:sqlite";
import { initSchema } from "../../../../../src/core/schema-init";
import { createReplicaService } from "../../../../../src/core/replica/service";
import { createDatabaseHost } from "./host";
import { databaseHTML } from "./bundle";
const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await Bun.sleep(10);
  }
  throw new Error("Shell timeout");
};
test("warm database shell opens, closes and reopens without stale records or reload", async () => {
  const db = new Database(":memory:");
  initSchema(db);
  const service = createReplicaService(db);
  const first = service.commands.createDatabase({ name: "First table" }),
    second = service.commands.createDatabase({ name: "Second table" });
  const p = service.commands.addProperty(first.id, {
      name: "Title",
      type: "text",
    }),
    q = service.commands.addProperty(second.id, {
      name: "Title",
      type: "text",
    });
  const status = service.commands.addProperty(first.id, {
    name: "Status",
    type: "select",
    config: { options: ["Todo", "Done"] },
  });
  const date = service.commands.addProperty(first.id, {
    name: "Date",
    type: "date",
  });
  const amount = service.commands.addProperty(first.id, {
    name: "Amount",
    type: "number",
  });
  service.commands.createRecord(first.id, {
    [p.id]: "first row",
    [status.id]: "Todo",
    [date.id]: new Date().toISOString().slice(0, 10),
    [amount.id]: 73,
  });
  service.commands.createRecord(second.id, { [q.id]: "second row" });
  const window = new Window({ url: "http://localhost" });
  const win = window as any;
  window.document.body.innerHTML = '<div id="app"></div>';
  const messages: any[] = [];
  let host: ReturnType<typeof createDatabaseHost>;
  win.ReactNativeWebView = {
    postMessage: (raw: string) => {
      const m = JSON.parse(raw);
      messages.push(m);
      const result =
        m.method === "performance"
          ? Promise.resolve(null)
          : host.call(m.method, m.args);
      void result.then(
        (value) =>
          win.__metahubDatabaseReceive({
            session: m.session,
            id: m.id,
            ok: true,
            value,
          }),
        (e) =>
          win.__metahubDatabaseReceive({
            session: m.session,
            id: m.id,
            ok: false,
            error: e.message,
          }),
      );
    },
  };
  try {
    const sandbox = Object.fromEntries(
      Object.getOwnPropertyNames(window)
        .map((key) => [key, win[key]])
        .filter(([, value]) => value !== undefined),
    );
    const context = createContext({
      ...sandbox,
      window,
      document: window.document,
      console,
      structuredClone,
    });
    for (const [, script] of databaseHTML
      .replace("__METAHUB_BOOTSTRAP__", "null")
      .matchAll(/<script>([\s\S]*?)<\/script>/g))
      runInContext(script!, context);
    for (const [i, [database, view]] of [
      [first, "table"],
      [first, "board"],
      [first, "calendar"],
      [first, "timeline"],
      [second, "table"],
      [first, "table"],
    ].entries() as any) {
      host = createDatabaseHost(service, database.id, () => true, {
        openRecord: () => {},
        clipboardRead: async () => "",
        clipboardWrite: async () => {},
      });
      const session = "s" + i;
      const metadata = await host.prepareOpening(view);
      win.__metahubOpenDatabaseSession({
        session,
        workspace: "test",
        databaseId: database.id,
        view,
        dark: false,
        preferences: {},
        metadata,
      });
      await waitFor(() =>
        messages.some(
          (m) =>
            m.session === session &&
            m.method === "performance" &&
            m.args[0].stage === "first-frame",
        ),
      );
      expect(window.document.body.textContent).toContain(
        database === first ? "first row" : "second row",
      );
      expect(
        messages.filter(
          (m) => m.session === session && m.method === "listDatabases",
        ),
      ).toHaveLength(0);
      expect(
        messages.filter(
          (m) => m.session === session && m.method === "listProperties",
        ),
      ).toHaveLength(0);
      await win.__metahubCloseDatabaseSession(session);
      expect(window.document.getElementById("app")!.childElementCount).toBe(0);
    }
  } finally {
    window.happyDOM.abort();
    service.dispose();
    db.close();
  }
}, 15000);
