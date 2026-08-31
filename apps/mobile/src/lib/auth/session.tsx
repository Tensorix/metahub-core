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
  listServers,
  loadCredentials,
  removeServer,
  saveCredentials,
  upsertServer,
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
  /** Switch to another saved server (no-op if it isn't in the list). */
  switchServer: (baseUrl: string) => Promise<void>;
  /** Forget the current server; falls back to the next saved one, or signs out. */
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
  // Bound to the originating server's base URL: a late renewal from a server
  // the user has switched away from updates that server's saved entry only —
  // it must never overwrite the now-active server's credentials.
  const handleToken = useCallback((fromBase: string, token: string) => {
    void upsertServer({ baseUrl: fromBase, token });
    const cur = sessionRef.current;
    if (!cur || cur.creds.baseUrl !== fromBase) return;
    const creds = { ...cur.creds, token };
    void saveCredentials(creds);
    setSession((prev) =>
      prev && prev.creds.baseUrl === fromBase
        ? { ...prev, creds, client: createClient({ baseUrl: fromBase, token }) }
        : prev,
    );
  }, []);

  const makeSession = useCallback(
    (creds: Credentials) =>
      buildSession(creds, (t) => handleToken(creds.baseUrl, t)),
    [handleToken],
  );

  useEffect(() => {
    let alive = true;
    // A SecureStore failure (e.g. Android keystore loss after backup-restore)
    // must land on onboarding, not hang the splash forever.
    loadCredentials()
      .catch(() => null)
      .then((creds) => {
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
      if (creds) {
        setSession(makeSession(creds));
        void upsertServer(creds); // idempotent; also captures dev auto-connect
      }
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [makeSession]);

  // Per session instance: start the SSE feed, rotate the token proactively on
  // launch + every return to foreground. Keyed on the LiveFeed instance — it
  // changes exactly when buildSession runs (server switch OR re-connect to
  // the same URL, which must tear the old stream down) and not on token
  // rotations (which must not churn the stream).
  const live = session?.live;
  const api = session?.api;
  useEffect(() => {
    if (!live || !api) return;
    live.install();
    void api.renew().catch(() => {});
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void api.renew().catch(() => {});
    });
    return () => {
      sub.remove();
      live.destroy();
    };
  }, [live, api]);

  const value = useMemo<SessionCtx>(
    () => ({
      ready,
      session,
      connect: async (creds) => {
        await Promise.all([saveCredentials(creds), upsertServer(creds)]);
        setSession(makeSession(creds));
      },
      switchServer: async (baseUrl) => {
        const target = (await listServers()).find((s) => s.baseUrl === baseUrl);
        if (!target) return;
        await saveCredentials(target);
        setSession(makeSession(target));
      },
      disconnect: async () => {
        const cur = sessionRef.current;
        const remaining = cur ? await removeServer(cur.creds.baseUrl) : [];
        const next = remaining[0];
        if (next) {
          await saveCredentials(next);
          setSession(makeSession(next));
        } else {
          await clearCredentials();
          setSession(null);
        }
      },
    }),
    [ready, session, makeSession],
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
