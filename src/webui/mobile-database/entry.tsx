/** @jsxImportSource preact */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { UiHost } from "../ui";
import { DatabaseView } from "../table";
import {
  boot,
  rpc,
  flush,
  checkpointReady,
  openingTrace,
  beginSession,
  endSession,
  sessionActive,
  type DatabaseBoot,
} from "./bridge";
function App() {
  const [configuration] = useState(boot);
  const [requestedView, setRequestedView] = useState(boot.view ?? null);
  useEffect(() => {
    const listener = (event: Event) =>
      setRequestedView((event as CustomEvent).detail);
    document.addEventListener("database-view-request", listener);
    return () =>
      document.removeEventListener("database-view-request", listener);
  }, []);
  const [db, setDb] = useState<any>(boot.metadata?.db ?? null),
    [error, setError] = useState("");
  const reload = () =>
    rpc<any[]>("listDatabases")
      .then((rows) => {
        const found = rows.find((r) => r.id === configuration.databaseId);
        if (!found) throw new Error("数据表已删除");
        openingTrace.mark("metadata-ready");
        setDb(found);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    const listener = (e: Event) => setError((e as CustomEvent).detail);
    document.addEventListener("mh-database-error", listener);
    return () => document.removeEventListener("mh-database-error", listener);
  }, []);
  useEffect(() => {
    if (!boot.metadata) void reload();
    const changed = (e: Event) => {
      if ((e as CustomEvent).detail?.datasets?.includes("databases"))
        void reload();
    };
    document.addEventListener("mh-synced", changed);
    return () => document.removeEventListener("mh-synced", changed);
  }, []);
  return (
    <>
      <UiHost />
      {error && (
        <div
          role="alert"
          class="mobile-db-error"
          onClick={() => {
            setError("");
            void reload();
          }}
        >
          {error} · 点击重试
        </div>
      )}
      {db ? (
        <DatabaseView
          initialProperties={boot.metadata?.props}
          db={db}
          rec={null}
          onRecNav={(id) => {
            if (id)
              void flush()
                .then(() => rpc("openRecord", id))
                .catch((e) => setError(e.message));
          }}
          tabReq={requestedView as any}
          onTabReq={() => setRequestedView(null)}
          onError={setError}
          host={{
            flush,
            openRecord: async (id) => {
              await flush();
              await rpc("openRecord", id);
            },
            pickDate: (value) => rpc("pickDate", value),
            clipboardRead: () => rpc("clipboardRead"),
            clipboardWrite: (text) => rpc("clipboardWrite", text),
            discardCheckpoint: async (id, pid) => {
              await checkpointReady();
              return rpc("discardCheckpoint", id, pid);
            },
          }}
          embedded
        />
      ) : (
        <p>正在打开数据表…</p>
      )}
    </>
  );
}
let closing: Promise<unknown> | null = null;
function openSession(config: DatabaseBoot) {
  beginSession(config);
  closing = null;
  (window as any).__METAHUB_DATABASE__ = config;
  document.documentElement.dataset.resolved = boot.dark ? "dark" : "light";
  document.body.classList.add("mobile-database");
  document.documentElement.dataset.fontScale = String(boot.fontScale ?? 1);
  document.documentElement.style.setProperty(
    "--database-font-scale",
    String(boot.fontScale ?? 1),
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => rpc("clipboardWrite", text),
      readText: () => rpc("clipboardRead"),
    },
  });

  document.body.inert = false;
  openingTrace.mark("shell-ready");
  if (config.metadata) openingTrace.mark("metadata-ready");
  render(<App />, document.getElementById("app")!);
}
async function closeSession(id: string) {
  if (!sessionActive() || boot.session !== id) return { closed: true };
  return (closing ??= (async () => {
    try {
      await flush();
      render(null, document.getElementById("app")!);
      await rpc("releaseQueries");
      endSession();
      document.body.inert = true;
      Reflect.deleteProperty(window, "__METAHUB_DATABASE__");
      window.scrollTo(0, 0);
      return { closed: true };
    } catch (error) {
      closing = null;
      throw error;
    }
  })());
}
Object.assign(window, {
  __metahubOpenDatabaseSession: openSession,
  __metahubCloseDatabaseSession: closeSession,
});
document.addEventListener(
  "click",
  (event) => {
    if (!sessionActive()) return;
    const link = (event.target as HTMLElement).closest("a");
    if (!link) return;
    const href = link.getAttribute("href") ?? "";
    event.preventDefault();
    event.stopPropagation();
    const doc = href.match(/^#\/doc\/([^/?]+)/),
      record = href.match(/^#\/db\/[^/]+\/([^/?]+)/);
    const operation = doc
      ? () => rpc("openDocument", decodeURIComponent(doc[1]!))
      : record
        ? () => rpc("openRecord", decodeURIComponent(record[1]!))
        : /^https?:/.test(href)
          ? () => rpc("openLink", href)
          : null;
    if (operation)
      void flush()
        .then(operation)
        .catch((e) =>
          document.dispatchEvent(
            new CustomEvent("mh-database-error", { detail: e.message }),
          ),
        );
  },
  true,
);
document.addEventListener("database-first-frame", () => {
  if (sessionActive()) openingTrace.mark("first-frame");
});
const initial = (window as any).__METAHUB_DATABASE__;
if (initial) openSession(initial);
