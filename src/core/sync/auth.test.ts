import { test, expect } from "bun:test";
import { queryTokenCookie, type AuthConfig } from "./auth.ts";

const cfg: AuthConfig = { debug: false, staticToken: "T0PSECRET", db: null, ttlMs: 0, graceMs: 0 };

function reqWith(headers: Record<string, string> = {}): Request {
  return new Request("https://x/", { headers });
}

test("queryTokenCookie persists a valid ?token= and marks it Secure over https", () => {
  const url = new URL("https://host/?token=T0PSECRET");
  const cookie = queryTokenCookie(reqWith(), url, cfg);
  expect(cookie).not.toBeNull();
  expect(cookie).toContain("mh_token=T0PSECRET");
  expect(cookie).toContain("; Secure");
  expect(cookie).toContain("SameSite=Strict");
});

test("queryTokenCookie omits Secure over http", () => {
  const url = new URL("http://host/?token=T0PSECRET");
  const cookie = queryTokenCookie(reqWith(), url, cfg);
  expect(cookie).not.toBeNull();
  expect(cookie).not.toContain("Secure");
});

test("queryTokenCookie returns null when the token is wrong, absent, or a cookie already exists", () => {
  expect(queryTokenCookie(reqWith(), new URL("https://host/?token=WRONG"), cfg)).toBeNull();
  expect(queryTokenCookie(reqWith(), new URL("https://host/"), cfg)).toBeNull();
  // already has a cookie session → don't re-set
  expect(
    queryTokenCookie(reqWith({ cookie: "mh_token=T0PSECRET" }), new URL("https://host/?token=T0PSECRET"), cfg),
  ).toBeNull();
});

test("queryTokenCookie is a no-op when auth is off", () => {
  const off: AuthConfig = { debug: true, staticToken: null, db: null, ttlMs: 0, graceMs: 0 };
  expect(queryTokenCookie(reqWith(), new URL("https://host/?token=anything"), off)).toBeNull();
});
