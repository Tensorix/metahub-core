import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runSchema } from "../db.ts";
import { loopbackUiRejection } from "./server.ts";
import { cookieMutationRejection, tokenStripRedirect } from "./auth.ts";
import { peersRoutes } from "./peers-routes.ts";
import { addPeer } from "./peers.ts";
import { mintGrant } from "./pairing.ts";

describe("/api/devices credential masking", () => {
  test("the devices roster never serializes a full grant token", async () => {
    const db = new Database(":memory:");
    runSchema(db);
    db.query("INSERT INTO meta (key, value) VALUES ('node_id', ?)").run("selfnode");
    addPeer(db, { url: "http://box:7777", label: "盒子", node_id: "boxnode1" });
    const token = mintGrant(db, "http://box:7777", "boxnode1");

    const route = peersRoutes.find((r) => r.method === "GET" && r.path === "/api/devices")!;
    const res = await route.handler(new Request("http://x/api/devices"), {
      db,
      node: "selfnode",
    });
    const body = await res.text();
    // channels[].ref AND revocationSources both stay at the 8-char prefix —
    // full tokens are only served by /api/grants (documented contract).
    expect(body).not.toContain(token);
    expect(body).toContain(token.slice(0, 8));
  });
});

describe("same-origin site page containment", () => {
  const AUTH: import("./auth.ts").AuthConfig = {
    debug: false,
    staticToken: "master-token-1234",
    db: null,
    ttlMs: 0,
    graceMs: 0,
  };
  const u = (path: string) => new URL("http://127.0.0.1:7777" + path);

  test("cookie-only mutations on /api are refused; explicit token passes", async () => {
    const cookieOnly = new Request("http://x/api/share", {
      method: "POST",
      headers: { cookie: "mh_token=master-token-1234" },
    });
    const rej = cookieMutationRejection(cookieOnly, u("/api/share"), AUTH);
    expect(rej?.status).toBe(401);

    const bearer = new Request("http://x/api/share", {
      method: "POST",
      headers: { authorization: "Bearer master-token-1234" },
    });
    expect(cookieMutationRejection(bearer, u("/api/share"), AUTH)).toBeNull();

    // GET sub-resources (img/EventSource can't carry headers) keep riding the cookie.
    const get = new Request("http://x/api/blob/abc", {
      headers: { cookie: "mh_token=master-token-1234" },
    });
    expect(cookieMutationRejection(get, u("/api/blob/abc"), AUTH)).toBeNull();

    // Auth off (--debug/desktop) — no gate at all.
    expect(
      cookieMutationRejection(cookieOnly, u("/api/share"), { ...AUTH, debug: true }),
    ).toBeNull();
  });

  test("?token= navigation gets a 302 with the token stripped and cookie set", () => {
    const nav = new Request("http://x/?token=master-token-1234", {
      headers: { accept: "text/html" },
    });
    const res = tokenStripRedirect(nav, u("/?token=master-token-1234"), AUTH)!;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).not.toContain("token");
    expect(res.headers.get("set-cookie")).toContain("mh_token=");

    // Wrong token: no redirect — the gate answers (unlock page / 401).
    const bad = new Request("http://x/?token=wrong", { headers: { accept: "text/html" } });
    expect(tokenStripRedirect(bad, u("/?token=wrong"), AUTH)).toBeNull();

    // API calls with ?token= are not navigations — left alone.
    const api = new Request("http://x/api/nodes?token=master-token-1234");
    expect(tokenStripRedirect(api, u("/api/nodes?token=master-token-1234"), AUTH)).toBeNull();
  });
});

describe("desktop loopback UI guard", () => {
  test("accepts the exact loopback host and same-origin mutation", () => {
    const req = new Request("http://127.0.0.1:4567/api/share", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:4567",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(loopbackUiRejection(req, 4567)).toBeNull();
  });

  test("rejects DNS-rebinding hosts and cross-site simple POSTs", () => {
    expect(
      loopbackUiRejection(new Request("http://attacker.test:4567/api/share"), 4567)?.status,
    ).toBe(403);
    expect(
      loopbackUiRejection(
        new Request("http://127.0.0.1:4567/api/share", {
          method: "POST",
          headers: {
            origin: "https://attacker.test",
            "content-type": "text/plain",
            "sec-fetch-site": "cross-site",
          },
        }),
        4567,
      )?.status,
    ).toBe(403);
    expect(
      loopbackUiRejection(
        new Request("http://127.0.0.1:4567/api/share", {
          method: "DELETE",
        }),
        4567,
      )?.status,
    ).toBe(403);
  });
});
