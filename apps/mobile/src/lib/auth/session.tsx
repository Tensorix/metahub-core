import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Platform } from "react-native";

import { createClient, type MetahubClient } from "../api/sdk";
import { LiveFeed } from "../api/live";
import { createMobileApi, type MobileApi } from "../api/mobile-api";
import {
  clearCredentials,
  loadCredentials,
  saveCredentials,
  type Credentials,
} from "./credentials";

interface Session {
  creds: Credentials;
  client: MetahubClient;
  api: MobileApi;
  live: LiveFeed;
}

interface SessionCtx {
  /** null while SecureStore loads, then either a session or signed-out. */
  ready: boolean;
  session: Session | null;
  connect: (creds: Credentials) => Promise<void>;
  disconnect: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

function buildSession(
  creds: Credentials,
  onToken: (token: string) => void,
): Session {
  const api = createMobileApi(creds, onToken);
  return {
    creds,
    // manifestUrl guessing is a static-site concern; a direct server client
    // must not probe /mh-deploy.json on every cold start.
    client: createClient({ baseUrl: creds.baseUrl, token: creds.token }),
    api,
    live: new LiveFeed(api),
  };
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // A renewed token must rebuild the SDK client (its explicit token is frozen
  // at creation). api/live self-update (live token getter) and keep running.
  const handleToken = useCallback((token: string) => {
    setSession((cur) => {
      if (!cur) return cur;
      const creds = { ...cur.creds, token };
      return { ...cur, creds, client: createClient({ baseUrl: creds.baseUrl, token }) };
    });
  }, []);

  useEffect(() => {
    let alive = true;
    loadCredentials().then((creds) => {
      if (!alive) return;
      // Dev convenience: EXPO_PUBLIC_MH_URL/TOKEN auto-connects a fresh
      // install so simulator runs skip onboarding. Dev builds only.
      if (!creds && __DEV__) {
        let url = process.env.EXPO_PUBLIC_MH_URL;
        const token = process.env.EXPO_PUBLIC_MH_TOKEN;
        // Android emulator reaches the host at 10.0.2.2, not loopback.
        if (url && Platform.OS === "android")
          url = url.replace(/\/\/(127\.0\.0\.1|localhost)/, "//10.0.2.2");
        if (url && token) creds = { baseUrl: url.replace(/\/$/, ""), token };
      }
      if (creds) setSession(buildSession(creds, handleToken));
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [handleToken]);

  // Per server connection: start the SSE feed, rotate the token proactively on
  // launch + every return to foreground. Keyed on base URL so token swaps
  // (which keep api/live instances) don't churn the stream.
  const baseUrl = session?.creds.baseUrl;
  useEffect(() => {
    if (!baseUrl) return;
    const cur = sessionRef.current;
    if (!cur) return;
    cur.live.install();
    void cur.api.renew().catch(() => {});
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void sessionRef.current?.api.renew().catch(() => {});
    });
    return () => {
      sub.remove();
      cur.live.destroy();
    };
  }, [baseUrl]);

  const value = useMemo<SessionCtx>(
    () => ({
      ready,
      session,
      connect: async (creds) => {
        await saveCredentials(creds);
        setSession(buildSession(creds, handleToken));
      },
      disconnect: async () => {
        await clearCredentials();
        setSession(null);
      },
    }),
    [ready, session, handleToken],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSessionCtx(): SessionCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSessionCtx outside SessionProvider");
  return v;
}

/** For screens behind the auth gate, where a session is guaranteed. */
export function useSession(): Session {
  const { session } = useSessionCtx();
  if (!session) throw new Error("useSession without an active session");
  return session;
}
