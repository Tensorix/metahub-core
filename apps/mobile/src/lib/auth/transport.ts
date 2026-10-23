/** One session's auth transport. Never shares mutable token state across sessions. */
export function createAuthTransport(
  baseUrl: string,
  initialToken: string,
  options: {
    fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    onToken?: (token: string) => void;
    onInvalid?: () => void;
  } = {},
) {
  const base = new URL(baseUrl).origin;
  const send =
    options.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  let token = initialToken;
  let active = true;
  let invalid = false;
  let renewal: Promise<void> | null = null;
  const invalidate = () => {
    if (active && !invalid) {
      invalid = true;
      options.onInvalid?.();
    }
  };
  const exec = (url: string, init: RequestInit, transport = send) => {
    if (!active) return Promise.reject(new Error("Session ended"));
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return transport(url, { ...init, headers });
  };
  const renew = (): Promise<void> => {
    if (!active || invalid) return Promise.resolve();
    if (renewal) return renewal;
    renewal = (async () => {
      const res = await exec(`${base}/auth/token`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!active) return;
      if (res.status === 401) {
        invalidate();
        return;
      }
      if (!res.ok) throw new Error(`Token renewal failed: ${res.status}`);
      const data = (await res.json()) as { token?: unknown };
      if (
        active &&
        typeof data.token === "string" &&
        data.token &&
        data.token !== token
      ) {
        token = data.token;
        options.onToken?.(token);
      }
    })().finally(() => {
      renewal = null;
    });
    return renewal;
  };
  const fetchUrl = async (
    url: string,
    init: RequestInit = {},
    transport = send,
  ): Promise<Response> => {
    // Reject rather than attach a credential to a manifest's external endpoint.
    if (new URL(url).origin !== base)
      throw new Error("Cross-origin session request refused");
    if (invalid) return new Response(null, { status: 401 });
    const sentToken = token;
    let res = await exec(url, init, transport);
    if (!active) throw new Error("Session ended");
    if (res.status === 401) {
      // A concurrent request may already have renewed the token.
      if (sentToken === token) {
        try {
          await renew();
        } catch {
          return res;
        }
      }
      if (!active) throw new Error("Session ended");
      if (!invalid && token !== sentToken)
        res = await exec(url, init, transport);
      if (!active) throw new Error("Session ended");
      if (res.status === 401) invalidate();
    }
    return res;
  };
  return {
    fetchUrl,
    renew,
    get token() {
      return token;
    },
    get invalid() {
      return invalid;
    },
    dispose() {
      active = false;
    },
  };
}
