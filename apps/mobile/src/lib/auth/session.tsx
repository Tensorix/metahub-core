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
  /** Changes on reconnect/switch, never on token rotation. */
  id: number;
  creds: Credentials;
  client: MetahubClient;
  api: MobileApi;
  live: LiveFeed;
  authInvalid: boolean;
}
interface SessionCtx {
  ready: boolean;
  session: Session | null;
  connect: (creds: Credentials) => Promise<void>;
  switchServer: (baseUrl: string) => Promise<void>;
  disconnect: () => Promise<void>;
}
const Ctx = createContext<SessionCtx | null>(null);
let nextId = 0;

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const current = useRef<Session | null>(null);
  const writes = useRef(Promise.resolve());
  const epoch = useRef(0);
  // SecureStore writes are serialized so an old token cannot finish saving over
  // a subsequently selected server. Failed writes don't poison the queue.
  const persist = useCallback((job: () => Promise<void>) => {
    const pending = writes.current.then(job);
    writes.current = pending.catch(() => {});
    return pending;
  }, []);
  const adopt = useCallback((next: Session | null) => {
    current.current?.api.dispose();
    current.current?.live.destroy();
    current.current = next;
    setSession(next);
  }, []);
  const makeSession = useCallback(
    (creds: Credentials): Session => {
      const id = ++nextId;
      const api = createMobileApi(
        creds,
        (token) => {
          const cur = current.current;
          if (cur?.id !== id) return;
          const next = { ...cur, creds: { ...cur.creds, token } };
          current.current = next;
          setSession(next);
          void persist(async () => {
            if (current.current?.id !== id) return;
            await upsertServer(next.creds);
            await saveCredentials(next.creds);
          }).catch(() => {});
        },
        () => {
          const cur = current.current;
          if (cur?.id !== id) return;
          const next = { ...cur, authInvalid: true };
          current.current = next;
          setSession(next);
          cur.live.destroy();
        },
      );
      return {
        id,
        creds,
        api,
        authInvalid: false,
        client: createClient({
          baseUrl: creds.baseUrl,
          token: creds.token,
          fetch: api.fetchUrl,
        }),
        live: new LiveFeed(api),
      };
    },
    [persist],
  );

  useEffect(() => {
    let alive = true;
    const generation = epoch.current;
    void loadCredentials()
      .catch(() => null)
      .then((saved) => {
        if (!alive || generation !== epoch.current) return;
        let creds = saved;
        if (!creds && __DEV__) {
          let url = process.env.EXPO_PUBLIC_MH_URL;
          const token = process.env.EXPO_PUBLIC_MH_TOKEN;
          if (url && Platform.OS === "android")
            url = url.replace(/\/\/(127\.0\.0\.1|localhost)/, "//10.0.2.2");
          if (url && token) creds = { baseUrl: url.replace(/\/$/, ""), token };
        }
        if (creds) adopt(makeSession(creds));
        setReady(true);
      });
    return () => {
      alive = false;
      current.current?.api.dispose();
      current.current?.live.destroy();
    };
  }, [adopt, makeSession]);

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
      connect: (creds) =>
        persist(async () => {
          await upsertServer(creds);
          await saveCredentials(creds);
          epoch.current++;
          adopt(makeSession(creds));
        }),
      switchServer: (baseUrl) =>
        persist(async () => {
          const target = (await listServers()).find(
            (s) => s.baseUrl === baseUrl,
          );
          if (!target) return;
          await saveCredentials(target);
          epoch.current++;
          adopt(makeSession(target));
        }),
      disconnect: () =>
        persist(async () => {
          const cur = current.current;
          const remaining = cur ? await removeServer(cur.creds.baseUrl) : [];
          const next = remaining[0];
          if (next) await saveCredentials(next);
          else await clearCredentials();
          epoch.current++;
          adopt(next ? makeSession(next) : null);
        }),
    }),
    [ready, session, persist, adopt, makeSession],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useSessionCtx(): SessionCtx {
  const value = useContext(Ctx);
  if (!value) throw new Error("useSessionCtx outside SessionProvider");
  return value;
}
export function useSession(): Session {
  const { session } = useSessionCtx();
  if (!session) throw new Error("useSession without an active session");
  return session;
}
