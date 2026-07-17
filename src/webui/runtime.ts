// /mh-runtime.js — injected into every HTML the server (or the service worker,
// offline) serves except the unlock page: hosted /sites/* pages, /docs, and
// the WebUI shell. Replaces the old inline fetch shim and gives hosted site
// pages the full offline story with zero changes to their code:
//
//   1. Token shim: same-origin fetch carries the stored Bearer token; a 401
//      transparently renews via /auth/token and retries once.
//   2. Service worker registration (secure context only), so a site page
//      opened directly still installs the offline gateway.
//   3. SW bridge: answers the gateway's local-RPC requests through the
//      replica bus — so an offline site page can read AND write hub data via
//      this device's replica (Web Locks decide which tab owns the worker).
//
// In the WebUI shell the app bundle manages the replica itself; the
// globalThis guards below make double-injection harmless there.

import { getReplicaBus, BusError } from "./data/replica-bus.ts";
import { injectRuntimeTag } from "../core/inject-runtime.ts";

const TOKEN_KEY = "mh_token";
const RENEW_PATH = "/auth/token";

const g = globalThis as {
  __mhFetchShim?: boolean;
  __mhSwBridge?: boolean;
};

// ---- 1. token shim --------------------------------------------------------------

function saveToken(t: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* private mode */
  }
  document.cookie = `${TOKEN_KEY}=${encodeURIComponent(t)}; path=/; SameSite=Strict; Max-Age=31536000`;
}

if (!g.__mhFetchShim) {
  g.__mhFetchShim = true;
  const orig = window.fetch.bind(window);
  const shimmed = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    init = init ?? {};
    let token: string | null = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* private mode */
    }
    let url: URL | null = null;
    try {
      url = new URL(
        typeof input === "string" || input instanceof URL ? String(input) : input.url,
        location.href,
      );
    } catch {
      url = null;
    }
    const same = url != null && url.origin === location.origin;
    if (same && token) {
      const h = new Headers(init.headers ?? (typeof input !== "string" && !(input instanceof URL) ? input.headers : undefined));
      if (!h.has("authorization")) h.set("authorization", `Bearer ${token}`);
      init.headers = h;
    }
    return orig(input, init).then((res) => {
      const retried = (init as { __mhRetried?: boolean }).__mhRetried;
      if (res.status !== 401 || !same || !token || retried) return res;
      return orig(RENEW_PATH, { headers: { authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { token?: string } | null) => {
          if (!d?.token) return res;
          saveToken(d.token);
          const h2 = new Headers(init!.headers);
          h2.set("authorization", `Bearer ${d.token}`);
          init!.headers = h2;
          (init as { __mhRetried?: boolean }).__mhRetried = true;
          return orig(input, init);
        })
        .catch(() => res);
    });
  };
  window.fetch = shimmed as typeof window.fetch;
}

// ---- 2. service worker ------------------------------------------------------------

// Never inside the desktop shell: its windows are pure views onto the local
// sidecar, and a SW's network-first timeout fallback can pin them to a stale
// cached shell across app restarts (the quicknote window pre-warms while a dev
// sidecar is still cold-building the bundle). ensurePwaRegistration() applies
// the same surface gate for the app bundle; this guards the injected runtime.
if ("serviceWorker" in navigator && window.isSecureContext && !(window as { metahubDesktop?: unknown }).metahubDesktop) {
  navigator.serviceWorker.register("/sw.js").catch((e) => {
    // Progressive enhancement, but loud: a silent failure here costs the
    // entire offline story (e.g. a one-off 500 from a cold dev rebuild).
    console.warn("[mh-runtime] service worker registration failed —", e);
  });
}

// ---- 3. SW bridge (offline local RPC) ---------------------------------------------

function replicaUsable(): boolean {
  try {
    return localStorage.getItem("mh_replica") === "1" && localStorage.getItem("mh_replica_hydrated") === "1";
  } catch {
    return false;
  }
}

// ---- 4. cold-start offline bootstrap ----------------------------------------------
// The SW serves this shell when an offline /sites/* navigation finds no client
// to answer (e.g. the site opened directly from the home screen). Once this
// page is alive it IS a client: pull the real HTML straight off the replica
// bus and document.write it in place — window globals (bus, worker, guards)
// survive document.open(), so the written page's subresource requests are
// answered by this same tab.
(globalThis as { __mhOfflineBootstrap?: (site: string, path: string) => void }).__mhOfflineBootstrap = (
  site: string,
  path: string,
) => {
  const fail = (msg: string): void => {
    // textContent, not innerHTML: msg can carry a non-literal error string, and
    // this is the one fail() sink that isn't a static template — never let it
    // parse as markup.
    const p = document.createElement("p");
    p.style.cssText = "font:14px system-ui;color:#888;margin:2em";
    p.textContent = msg;
    document.body.replaceChildren(p);
  };
  if (!replicaUsable() || typeof Worker === "undefined") {
    fail("当前离线，且此浏览器尚未启用本地副本。请先在线打开 Metahub，在设置中开启「离线副本」。");
    return;
  }
  void (async () => {
    try {
      const bus = getReplicaBus();
      bus.start();
      const row = (await bus.call("siteFile", site, path)) as {
        content_type: string;
        encoding: string;
        content: string | null;
        public?: boolean;
      } | null;
      if (!row) {
        fail("离线副本中没有这个页面。");
        return;
      }
      if (!row.content_type.includes("text/html")) {
        fail("此资源不是页面，无法离线打开。");
        return;
      }
      // Defensive: HTML always stores inline (isTextType → utf8), never as a
      // blob — but the replica now passes blob rows through, so refuse loudly
      // instead of atob-ing a bare hash into garbage.
      if (row.encoding === "blob") {
        fail("此页面以二进制块存储，无法离线打开。");
        return;
      }
      const raw = row.encoding === "utf8" ? (row.content ?? "") : atob(row.content ?? "");
      // Public pages never carry the runtime — on any surface (same rule as
      // the server and the service worker: "preview is truth").
      const html = row.public ? raw : injectRuntimeTag(raw);
      document.open();
      document.write(html);
      document.close();
    } catch (e) {
      fail(`离线加载失败：${(e as Error).message}`);
    }
  })();
};

if (!g.__mhSwBridge && "serviceWorker" in navigator) {
  g.__mhSwBridge = true;
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { kind?: string; op?: string; args?: unknown[] } | null;
    const port = e.ports?.[0];
    if (!d || d.kind !== "mh-rpc" || !port || !d.op) return;
    if (!replicaUsable() || typeof Worker === "undefined") {
      port.postMessage({ ok: false, error: { message: "replica unavailable", code: "unavailable" } });
      return;
    }
    const bus = getReplicaBus();
    bus.start();
    bus.call(d.op, ...(d.args ?? [])).then(
      (result) => port.postMessage({ ok: true, result }),
      (err: BusError) =>
        port.postMessage({ ok: false, error: { message: err.message, code: err.code } }),
    );
  });
}
