// "Sign in with Cloudflare" — OAuth 2.0 Authorization Code + PKCE (S256) for the
// Edge deploy flow, replacing manual Account ID + API token entry. This is a
// PUBLIC client (no secret): the client_id is not sensitive and ships in the
// open-source build. Security rests on three non-secret layers — the redirect
// URI allowlist (a stolen client_id can't exfiltrate the code to a remote
// server), PKCE (a leaked code is useless without the verifier held only by the
// legit instance), and the verified consent-page name/logo.
//
// The flow runs on whichever machine will execute the deploy: a temporary
// loopback listener catches the redirect, so no official backend ever brokers
// the exchange (privacy-first). The resulting access token is short-lived and
// handed straight to deployEdge in the same position the pasted API token used
// to occupy — nothing downstream changes, and the token is never persisted.

import { MhError } from "../errors.ts";
import { toB64url } from "./e2ee.ts";

/** Registered OAuth client id. Overridable for self-hosters who register their
 *  own private client (see docs). Empty/placeholder → OAuth login is unavailable
 *  and callers fall back to manual token entry. */
export const CF_OAUTH_CLIENT_ID = process.env.METAHUB_CF_OAUTH_CLIENT_ID || "";

const AUTH_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const CF_API = "https://api.cloudflare.com/client/v4";

/** Minimal scopes the Edge deploy needs, using Cloudflare's self-managed OAuth
 *  scope identifiers (dotted, e.g. `d1.write` — NOT the wrangler `d1:write`
 *  style). Both read + write are requested for Workers Scripts and D1 because
 *  the deploy pipeline does GETs (existence checks, workers.dev subdomain
 *  lookup) as well as writes. `account-settings.read` backs account discovery.
 *  NOTE: the account-level /workers/subdomain PUT is assumed covered by
 *  workers-scripts.write (no dedicated subdomain scope exists); if a deploy
 *  fails there with a permission error, add the missing scope here + in the
 *  registered client. */
export const CF_OAUTH_SCOPES = [
  "account-settings.read",
  "workers-scripts.read",
  "workers-scripts.write",
  "d1.read",
  "d1.write",
  // R2 sync-bucket provisioning (provisionR2Bucket): bucket create/lookup only.
  // Minting R2 S3 credentials has NO OAuth scope (API-token creation is
  // classic-token-only) — that step stays a dashboard walk, by design.
  "workers-r2.read",
  "workers-r2.write",
];

const CALLBACK_PATH = "/oauth/cf/callback";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface CfToken {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
}

export interface CfAccount {
  id: string;
  name: string;
}

/** Is OAuth login available (a client id is configured)? */
export function cfOAuthConfigured(clientId = CF_OAUTH_CLIENT_ID): boolean {
  return clientId.trim().length > 0;
}

// ---- pure, testable pieces ----------------------------------------------------

/** Generate a PKCE verifier + S256 challenge. verifier is 32 random bytes
 *  base64url-encoded (43 chars, ~256 bits); challenge = base64url(SHA-256(verifier)). */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = toB64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge: toB64url(digest) };
}

export function buildAuthUrl(p: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scopes: string[];
  authEndpoint?: string;
}): string {
  const url = new URL(p.authEndpoint ?? AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scopes.join(" "),
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state,
  }).toString();
  return url.toString();
}

export function buildTokenRequestBody(p: {
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
}): string {
  return new URLSearchParams({
    grant_type: "authorization_code",
    client_id: p.clientId,
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  }).toString();
}

/** Parse the token endpoint's JSON response into a CfToken. */
export function parseTokenResponse(data: unknown): CfToken {
  const d = (data ?? {}) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!d.access_token)
    throw new MhError("auth", `Cloudflare 授权失败：${d.error_description || d.error || "未返回 access token"}`);
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token ?? null,
    expiresIn: typeof d.expires_in === "number" ? d.expires_in : null,
  };
}

/** Parse a Cloudflare /accounts result into id/name pairs. */
export function parseAccounts(data: unknown): CfAccount[] {
  const list = (data as { result?: { id?: string; name?: string }[] } | null)?.result ?? [];
  return list
    .filter((a): a is { id: string; name?: string } => typeof a.id === "string" && a.id.length > 0)
    .map((a) => ({ id: a.id, name: a.name ?? a.id }));
}

// ---- side-effecting pieces ----------------------------------------------------

async function exchangeCode(p: {
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  tokenEndpoint: string;
}): Promise<CfToken> {
  let res: Response;
  try {
    res = await fetch(p.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: buildTokenRequestBody(p),
    });
  } catch (e) {
    throw new MhError("network", `无法连接 Cloudflare 授权服务：${(e as Error).message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok && !(data as { access_token?: string })?.access_token)
    throw new MhError("auth", `Cloudflare 令牌交换失败（HTTP ${res.status}）`);
  return parseTokenResponse(data);
}

/** Discover the accounts the token can act on, so the user need not paste an
 *  Account ID. Single account → auto-select; multiple → caller prompts. */
export async function discoverAccounts(accessToken: string): Promise<CfAccount[]> {
  let res: Response;
  try {
    res = await fetch(`${CF_API}/accounts?per_page=50`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
  } catch (e) {
    throw new MhError("network", `无法读取 Cloudflare 账号列表：${(e as Error).message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new MhError("auth", `读取 Cloudflare 账号失败（HTTP ${res.status}）`);
  return parseAccounts(data);
}

/** Open a URL in the user's default browser (best-effort; caller should also
 *  print the URL as a fallback). */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
  } catch {
    // ignore — the caller shows the URL so the user can open it manually
  }
}

export interface CfLoginHandle {
  /** Consent URL to open in a browser. */
  authUrl: string;
  /** The loopback redirect the temporary listener is bound to. */
  redirectUri: string;
  /** Resolves once the browser redirect is caught and the code is exchanged.
   *  Rejects on state mismatch, user-denied consent, timeout, or exchange error.
   *  Always tears down the listener. */
  waitForToken(): Promise<CfToken>;
  /** Tear down the listener without waiting (e.g. modal closed). */
  cancel(): void;
}

/** Start an OAuth login: bind a temporary loopback listener, build the consent
 *  URL. The caller opens `authUrl` (CLI/desktop) or hands it to the browser
 *  (WebUI), then awaits `waitForToken()`. Endpoints/clientId are injectable for
 *  tests. */
export async function startCfLogin(opts: {
  clientId?: string;
  scopes?: string[];
  authEndpoint?: string;
  tokenEndpoint?: string;
  timeoutMs?: number;
} = {}): Promise<CfLoginHandle> {
  const clientId = opts.clientId ?? CF_OAUTH_CLIENT_ID;
  if (!cfOAuthConfigured(clientId))
    throw new MhError("invalid_input", "未配置 Cloudflare OAuth 客户端，请改用 API Token 部署");

  const { verifier, challenge } = await pkce();
  const state = toB64url(crypto.getRandomValues(new Uint8Array(16)));

  let settle!: (q: URLSearchParams) => void;
  const caught = new Promise<URLSearchParams>((resolve) => (settle = resolve));

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== CALLBACK_PATH) return new Response("not found", { status: 404 });
      settle(url.searchParams);
      return new Response(CALLBACK_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });

  const redirectUri = `http://127.0.0.1:${server.port}${CALLBACK_PATH}`;
  const authUrl = buildAuthUrl({
    clientId,
    redirectUri,
    challenge,
    state,
    scopes: opts.scopes ?? CF_OAUTH_SCOPES,
    authEndpoint: opts.authEndpoint,
  });

  let done = false;
  const stop = () => {
    if (!done) {
      done = true;
      server.stop(true);
    }
  };

  return {
    authUrl,
    redirectUri,
    cancel: stop,
    async waitForToken(): Promise<CfToken> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new MhError("network", "Cloudflare 授权超时，请重试")),
          opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
      });
      try {
        const q = await Promise.race([caught, timeout]);
        if (q.get("error"))
          throw new MhError("auth", `Cloudflare 授权被拒绝：${q.get("error_description") || q.get("error")}`);
        if (q.get("state") !== state)
          throw new MhError("auth", "OAuth state 不匹配，疑似伪造回调，已中止");
        const code = q.get("code");
        if (!code) throw new MhError("auth", "Cloudflare 未返回授权码");
        return await exchangeCode({
          clientId,
          code,
          verifier,
          redirectUri,
          tokenEndpoint: opts.tokenEndpoint ?? TOKEN_ENDPOINT,
        });
      } finally {
        if (timer) clearTimeout(timer);
        stop();
      }
    },
  };
}

const CALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>MetaHub</title>
<body style="font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>✅ 已授权</h2><p>可以关闭此标签页，回到 MetaHub 继续部署。</p></div>`;
