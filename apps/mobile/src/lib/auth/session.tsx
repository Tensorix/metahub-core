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
import * as SecureStore from "expo-secure-store";
import * as Network from "expo-network";
import { createMobileApi, type MobileApi } from "../api/mobile-api";
import {
  createAttachmentManager,
  type AttachmentManager,
} from "../attachments/native";
import { LiveFeed } from "../api/live";
import {
  openMobileReplica,
  createReplicaSync,
  type MobileReplica,
  type ReplicaClient,
  type ReplicaSync,
  type ReplicaChange,
} from "../replica";
import { initializeNativeSyncRuntime } from "../sync/runtime";
import { withSyncBudget } from "../../../../../src/core/sync/transport.ts";
import { getNodeId } from "../../../../../src/core/node.ts";
import {
  PairResponseSchema,
  PAIR_PATH,
} from "../../../../../src/core/sync/protocol.ts";
import {
  clearCredentials,
  listServers,
  loadCredentials,
  removeServer,
  saveCredentials,
  upsertServer,
  type Credentials,
} from "./credentials";
interface LocalFeed {
  readonly connected: boolean;
  onChange(fn: (change: ReplicaChange) => void): () => void;
  onStatus(fn: (connected: boolean) => void): () => void;
}
export interface Session {
  id: number;
  workspaceId: string;
  creds: Credentials;
  client: ReplicaClient;
  api: MobileApi;
  replica: MobileReplica;
  sync: ReplicaSync;
  attachments: AttachmentManager;
  live: LocalFeed;
  authInvalid: boolean;
  isCurrent(): boolean;
  syncNow(): Promise<void>;
  dispose(): Promise<void>;
}
interface SessionCtx {
  ready: boolean;
  error: string | null;
  session: Session | null;
  connect(c: Credentials): Promise<void>;
  switchServer(url: string): Promise<void>;
  disconnect(): Promise<void>;
}
const Ctx = createContext<SessionCtx | null>(null);
let nextId = 0;
async function workspaceKey(url: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(url),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 32);
}
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false),
    [session, setSession] = useState<Session | null>(null),
    [error, setError] = useState<string | null>(null);
  const current = useRef<Session | null>(null),
    writes = useRef(Promise.resolve()),
    epoch = useRef(0);
  const persist = useCallback((job: () => Promise<void>) => {
    const p = writes.current.then(job);
    writes.current = p.catch(() => {});
    return p;
  }, []);
  const makeSession = useCallback(
    async (creds: Credentials): Promise<Session> => {
      await initializeNativeSyncRuntime();
      const workspaceId = await workspaceKey(creds.baseUrl),
        id = ++nextId;
      const replica = openMobileReplica(workspaceId, {
        platform: Platform.OS === "android" ? "android" : "ios",
      });
      let disposed = false,
        grant: string | null = null,
        pairing: Promise<void> | null = null;
      const pairingAbort = new AbortController();
      const grantKey = `mh.sync.grant.${workspaceId}`;
      try {
        if (!creds.bucket) grant = await SecureStore.getItemAsync(grantKey);
      } catch (e) {
        replica.close();
        throw e;
      }
      const api = createMobileApi(
        creds,
        (token) => {
          const cur = current.current;
          if (cur?.id !== id || disposed) return;
          cur.creds = { ...cur.creds, token };
          setSession({ ...cur });
          void persist(async () => {
            if (current.current?.id !== id) return;
            await upsertServer(cur.creds);
            await saveCredentials(cur.creds);
          }).catch((e) => setError(String(e)));
        },
        () => {
          const cur = current.current;
          if (cur?.id !== id || disposed) return;
          cur.authInvalid = true;
          setSession({ ...cur });
        },
      );
      api.recordHistory = replica.service.client.recordHistory;
      api.recordAt = async (rid, v) => {
        const value = await replica.service.client.recordAt(rid, v);
        if (!value) throw new Error("历史版本不存在");
        return value;
      };
      api.revertRecord = replica.service.client.revertRecord;
      if (creds.bucket)
        api.version = async () => ({ version: "本地副本 · 存储桶同步" });
      const sync = createReplicaSync(replica.db, {
        batchSize: 25,
        targets: () =>
          disposed
            ? []
            : creds.bucket
              ? [{ kind: "s3", config: creds.bucket }]
              : grant
                ? [{ kind: "http", url: creds.baseUrl, token: grant }]
                : [],
        onChange: replica.service.notifyChanges,
      });
      const unsub = replica.service.onChange(() => sync.requestSync());
      const feed = creds.bucket ? null : new LiveFeed(api);
      const pair = async () => {
        if (creds.bucket || grant || disposed) return;
        if (pairing) return pairing;
        pairing = (async () => {
          const data = await withSyncBudget(async (signal) => {
            const codeResponse = await api.fetch("/api/pair/new", { method: "POST", signal });
            if (!codeResponse.ok) throw new Error(`设备配对失败 (${codeResponse.status})`);
            const code = await codeResponse.json() as { code: string };
            if (signal.aborted || disposed) throw signal.reason ?? new Error("Session ended");
            const res = await api.fetch(PAIR_PATH, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                code: code.code,
                node_id: getNodeId(replica.db),
                grant: Array.from(
                  crypto.getRandomValues(new Uint8Array(32)),
                  (b) => b.toString(16).padStart(2, "0"),
                ).join(""),
              }),
              signal,
            });
            if (!res.ok) throw new Error(`设备配对失败 (${res.status})`);
            return PairResponseSchema.parse(await res.json());
          }, 15000, pairingAbort.signal);
          if (disposed) return;
          await SecureStore.setItemAsync(grantKey, data.grant);
          if (!disposed) grant = data.grant;
        })().finally(() => {
          pairing = null;
        });
        return pairing;
      };
      const syncNow = async () => {
        if (disposed) return;
        await pair();
        if (!disposed) await sync.syncNow();
      };
      const feedUnsub = feed?.onChange(() => {
        void syncNow().catch(() => {});
      });
      let lifecycle: { remove(): void } | undefined,
        network: { remove(): void } | undefined,
        retry: ReturnType<typeof setInterval> | undefined;
      const attachments = createAttachmentManager({
        db: replica.db,
        workspaceId,
        creds,
        api,
        isCurrent: () => !disposed && current.current?.id === id,
      });
      const attachmentSync = sync.onStatus((status) => {
        const cur = current.current;
        if (status.authInvalid && !disposed && cur?.id === id && !cur.authInvalid) {
          cur.authInvalid = true;
          setSession({ ...cur });
        }
        if (status.connected && !disposed)
          void attachments.retryPending().catch(() => {});
      });
      const result: Session = {
        id,
        workspaceId,
        creds,
        client: replica.service.client,
        api,
        replica,
        sync,
        attachments,
        authInvalid: false,
        live: {
          get connected() {
            return sync.status.connected;
          },
          onChange: replica.service.onChange,
          onStatus(fn) {
            fn(sync.status.connected);
            return sync.onStatus((s) => fn(s.connected));
          },
        },
        isCurrent: () => !disposed && current.current?.id === id,
        syncNow,
        async dispose() {
          if (disposed) return;
          disposed = true;
          pairingAbort.abort();
          lifecycle?.remove();
          network?.remove();
          if (retry) clearInterval(retry);
          feedUnsub?.();
          feed?.destroy();
          unsub();
          attachmentSync();
          attachments.dispose();
          api.dispose();
          await Promise.allSettled([sync.stop(), pairing]);
          replica.close();
        },
      };
      // Network initialization does not block offline workspace startup.
      setTimeout(() => {
        if (disposed) return;
        const attempt = () => {
          void syncNow().catch((e) => {
            if (current.current?.id === id)
              setError(e instanceof Error ? e.message : "同步失败");
          });
        };
        sync.start();
        feed?.install();
        attempt();
        lifecycle = AppState.addEventListener("change", (state) => {
          sync.setActive(state === "active");
          if (state === "active") attempt();
        });
        network = Network.addNetworkStateListener((state) => {
          if (state.isConnected) attempt();
        });
        retry = setInterval(() => {
          if (!grant && !creds.bucket && AppState.currentState === "active")
            attempt();
        }, 15000);
      }, 0);
      return result;
    },
    [persist],
  );
  const adopt = useCallback(
    async (creds: Credentials | null) => {
      const generation = epoch.current;
      if (current.current) await current.current.dispose();
      current.current = null;
      setSession(null);
      const next = creds ? await makeSession(creds) : null;
      if (generation !== epoch.current) {
        await next?.dispose();
        return;
      }
      current.current = next;
      setSession(next);
      setError(null);
    },
    [makeSession],
  );
  useEffect(() => {
    let alive = true;
    const lifecycleEpoch = epoch;
    const generation = lifecycleEpoch.current;
    void persist(async () => {
      let saved = await loadCredentials();
      if (!saved && __DEV__) {
        let url = process.env.EXPO_PUBLIC_MH_URL;
        const token = process.env.EXPO_PUBLIC_MH_TOKEN;
        if (url && token) {
          if (Platform.OS === "android")
            url = url.replace(/\/\/(127\.0\.0\.1|localhost)/, "//10.0.2.2");
          saved = { baseUrl: url.replace(/\/$/, ""), token };
        }
      }
      if (alive && generation === epoch.current) await adopt(saved);
    })
      .catch((e) => {
        if (alive)
          setError(e instanceof Error ? e.message : "本地工作区打开失败");
      })
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
      lifecycleEpoch.current++;
      void current.current?.dispose();
    };
  }, [adopt, persist]);
  const value = useMemo<SessionCtx>(
    () => ({
      ready,
      error,
      session,
      connect: (creds) =>
        persist(async () => {
          epoch.current++;
          await current.current?.dispose();
          await initializeNativeSyncRuntime();
          if (!creds.bucket)
            await SecureStore.deleteItemAsync(
              `mh.sync.grant.${await workspaceKey(creds.baseUrl)}`,
            );
          await adopt(creds);
          await upsertServer(creds);
          await saveCredentials(creds);
        }),
      switchServer: (url) =>
        persist(async () => {
          const target = (await listServers()).find((s) => s.baseUrl === url);
          if (!target) throw new Error("工作区不存在");
          epoch.current++;
          await adopt(target);
          await saveCredentials(target);
        }),
      disconnect: () =>
        persist(async () => {
          const cur = current.current;
          const rest = cur ? await removeServer(cur.creds.baseUrl) : [];
          epoch.current++;
          await adopt(rest[0] ?? null);
          if (rest[0]) await saveCredentials(rest[0]);
          else await clearCredentials();
        }),
    }),
    [ready, error, session, persist, adopt],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useSessionCtx(): SessionCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSessionCtx outside provider");
  return ctx;
}
export function useSession(): Session {
  const { session } = useSessionCtx();
  if (!session) throw new Error("No active workspace");
  return session;
}
