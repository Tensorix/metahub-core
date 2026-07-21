import { test, expect } from "bun:test";
import { toB64url } from "./e2ee.ts";
import {
  pkce,
  buildAuthUrl,
  buildTokenRequestBody,
  parseTokenResponse,
  parseAccounts,
  cfOAuthConfigured,
  startCfLogin,
} from "./cf-oauth.ts";

test("pkce: challenge is base64url(SHA-256(verifier)) and verifier is 256-bit url-safe", async () => {
  const { verifier, challenge } = await pkce();
  expect(verifier).toMatch(/^[A-Za-z0-9\-_]{43}$/); // 32 bytes → 43 unpadded chars
  expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  const expected = toB64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  expect(challenge).toBe(expected);
  // fresh each call
  expect((await pkce()).verifier).not.toBe(verifier);
});

test("buildAuthUrl carries PKCE S256 + state + scopes", () => {
  const u = new URL(
    buildAuthUrl({
      clientId: "cid",
      redirectUri: "http://127.0.0.1:5555/oauth/cf/callback",
      challenge: "chal",
      state: "st8",
      scopes: ["account:read", "d1:write"],
      authEndpoint: "https://example.test/auth",
    }),
  );
  expect(u.origin + u.pathname).toBe("https://example.test/auth");
  expect(u.searchParams.get("response_type")).toBe("code");
  expect(u.searchParams.get("client_id")).toBe("cid");
  expect(u.searchParams.get("code_challenge")).toBe("chal");
  expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  expect(u.searchParams.get("state")).toBe("st8");
  expect(u.searchParams.get("scope")).toBe("account:read d1:write");
  expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5555/oauth/cf/callback");
});

test("buildTokenRequestBody is form-encoded authorization_code with verifier", () => {
  const body = new URLSearchParams(
    buildTokenRequestBody({ clientId: "cid", code: "abc", verifier: "ver", redirectUri: "http://x/cb" }),
  );
  expect(body.get("grant_type")).toBe("authorization_code");
  expect(body.get("client_id")).toBe("cid");
  expect(body.get("code")).toBe("abc");
  expect(body.get("code_verifier")).toBe("ver");
  expect(body.get("redirect_uri")).toBe("http://x/cb");
});

test("parseTokenResponse: happy path + error surfaces MhError", () => {
  expect(parseTokenResponse({ access_token: "T", refresh_token: "R", expires_in: 3600 })).toEqual({
    accessToken: "T",
    refreshToken: "R",
    expiresIn: 3600,
  });
  expect(parseTokenResponse({ access_token: "T" })).toEqual({
    accessToken: "T",
    refreshToken: null,
    expiresIn: null,
  });
  expect(() => parseTokenResponse({ error: "invalid_grant", error_description: "bad code" })).toThrow(
    /bad code/,
  );
});

test("parseAccounts: single, multi, and id-less rows filtered", () => {
  expect(parseAccounts({ result: [{ id: "a1", name: "Acme" }] })).toEqual([{ id: "a1", name: "Acme" }]);
  expect(parseAccounts({ result: [{ id: "a1" }, { id: "a2", name: "Two" }] })).toEqual([
    { id: "a1", name: "a1" },
    { id: "a2", name: "Two" },
  ]);
  expect(parseAccounts({ result: [{ name: "no-id" }] })).toEqual([]);
  expect(parseAccounts(null)).toEqual([]);
});

test("cfOAuthConfigured reflects a non-empty client id", () => {
  expect(cfOAuthConfigured("")).toBe(false);
  expect(cfOAuthConfigured("   ")).toBe(false);
  expect(cfOAuthConfigured("real-client")).toBe(true);
});

test("startCfLogin: full loopback flow catches the redirect and exchanges the code", async () => {
  // Mock Cloudflare token endpoint.
  const token = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = new URLSearchParams(await req.text());
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("the-code");
      expect(body.get("code_verifier")).toBeTruthy();
      return Response.json({ access_token: "ACCESS", refresh_token: "REFRESH", expires_in: 7200 });
    },
  });
  try {
    const login = await startCfLogin({
      clientId: "test-client",
      authEndpoint: "https://example.test/auth",
      tokenEndpoint: `http://127.0.0.1:${token.port}/token`,
      timeoutMs: 10_000,
    });
    const state = new URL(login.authUrl).searchParams.get("state")!;
    expect(login.redirectUri).toContain("/oauth/cf/callback");

    // Simulate the browser redirect hitting the loopback catcher.
    const page = await fetch(`${login.redirectUri}?code=the-code&state=${encodeURIComponent(state)}`);
    expect(page.status).toBe(200);

    const got = await login.waitForToken();
    expect(got).toEqual({ accessToken: "ACCESS", refreshToken: "REFRESH", expiresIn: 7200 });
  } finally {
    token.stop(true);
  }
});

test("startCfLogin: state mismatch is rejected", async () => {
  const login = await startCfLogin({
    clientId: "test-client",
    authEndpoint: "https://example.test/auth",
    tokenEndpoint: "http://127.0.0.1:1/token",
    timeoutMs: 5_000,
  });
  await fetch(`${login.redirectUri}?code=x&state=WRONG`);
  await expect(login.waitForToken()).rejects.toThrow(/state 不匹配/);
});

test("startCfLogin: user-denied consent surfaces the error", async () => {
  const login = await startCfLogin({
    clientId: "test-client",
    authEndpoint: "https://example.test/auth",
    tokenEndpoint: "http://127.0.0.1:1/token",
    timeoutMs: 5_000,
  });
  await fetch(`${login.redirectUri}?error=access_denied&error_description=nope`);
  await expect(login.waitForToken()).rejects.toThrow(/被拒绝/);
});

test("startCfLogin: throws when no client id is configured", async () => {
  await expect(startCfLogin({ clientId: "" })).rejects.toThrow(/未配置/);
});
