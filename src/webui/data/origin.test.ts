import { test, expect } from "bun:test";
import { classifyOrigin } from "./origin.ts";

// A 502/503 is a *response*, not a failure — but it means "server present, mid
// deploy", not "no server". The regression this guards: a transient 5xx getting
// cached as "none" and bricking a first-visit user onto the enroll screen.
const res = (status: number) => new Response("x", { status });

test("classifyOrigin: a healthy server (2xx + {ok:true}) is 'server'", () => {
  expect(classifyOrigin(res(200), { ok: true })).toBe("server");
});

test("classifyOrigin: a 2xx non-health body (CDN SPA fallback → index.html) is 'none'", () => {
  expect(classifyOrigin(res(200), null)).toBe("none");
});

test("classifyOrigin: a 404 (no /health route) is 'none' — a static host", () => {
  expect(classifyOrigin(res(404), null)).toBe("none");
});

test("classifyOrigin: a transient 5xx is 'unknown', never cached as 'none'", () => {
  expect(classifyOrigin(res(502), null)).toBe("unknown");
  expect(classifyOrigin(res(503), null)).toBe("unknown");
});

test("classifyOrigin: a network/parse failure (res === null) is 'unknown'", () => {
  expect(classifyOrigin(null, null)).toBe("unknown");
});
