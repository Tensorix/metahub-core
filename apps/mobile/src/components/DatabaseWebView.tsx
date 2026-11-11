import { databaseBenchmark } from "@/lib/diagnostics/database-mode";
import { NativeButton } from "@/components/native/NativeButton";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { parseDate, toISO } from "../../../../src/shared/views/date";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useId,
  useCallback,
} from "react";
import {
  AppState,
  Platform,
  View,
  Text,
  Pressable,
  Alert,
  Modal,
  Linking,
  useWindowDimensions,
} from "react-native";
import { DatabaseSurface } from "./DatabaseSurface";
import type { DatabaseSurfaceHandle } from "./DefaultDatabaseSurface";
import { SessionOwner } from "@/lib/editor/session-owner";
import {
  databaseRuntimeDiagnostics,
  reusesDatabaseRuntime,
  warmDatabaseSurface,
} from "@/lib/database/warmup";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useHeaderHeight,
  usePreventRemove,
} from "expo-router/react-navigation";
import { registerRecoveryEditor } from "@/lib/editor/recovery-barrier";
import * as Clipboard from "expo-clipboard";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";

import { createDatabaseHost } from "@/lib/database/host";
import { scriptJSON } from "@/lib/editor/protocol";
import { preferSurface } from "@/lib/database/prewarm";
import { createDatabaseTrace } from "../../../../src/shared/views/database-performance";
const databaseOwner = new SessionOwner();
export function DatabaseWebView({
  databaseId,
  initialView,
  deleted = false,
  onTitle,
}: {
  databaseId: string;
  initialView?: string;
  deleted?: boolean;
  onTitle?(title: string): void;
}) {
  const { fontScale } = useWindowDimensions();
  const headerHeight = useHeaderHeight(),
    insets = useSafeAreaInsets();
  const session = useSession(),
    router = useRouter(),
    { scheme, tokens } = useTheme(),
    web = useRef<DatabaseSurfaceHandle>(null);
  const [generation, setGeneration] = useState(0),
    [error, setError] = useState("");
  const [dateRequest, setDateRequest] = useState<{
    value: Date;
    resolve(value: string | null | undefined): void;
  } | null>(null);
  const dateRef = useRef(dateRequest);
  useEffect(() => {
    dateRef.current = dateRequest;
  }, [dateRequest]);
  const [initialFontScale] = useState(fontScale);
  const [bootstrapView] = useState(initialView);
  const openingView = generation === 0 ? bootstrapView : undefined;
  const needsReopen = useRef(false);
  const [initialDark] = useState(scheme === "dark");
  const instance = useId();
  const nonce = `${session.id}:${databaseId}:${generation}:${instance}`;
  const openingTrace = useMemo(
    () =>
      createDatabaseTrace(nonce, "native", (sample) =>
        console.info("[database-open]", JSON.stringify(sample)),
      ),
    [nonce],
  );
  useEffect(() => {
    preferSurface("database");
    openingTrace.mark("route-mounted");
  }, [openingTrace]);
  const host = useMemo(
    () =>
      createDatabaseHost(
        session.replica.service,
        databaseId,
        session.isCurrent,
        {
          openRecord: (id) => router.push(`/record/${id}`),
          clipboardWrite: async (text) => {
            await Clipboard.setStringAsync(text);
          },
          clipboardRead: Clipboard.getStringAsync,
          openDocument: (id) => router.push(`/doc/${id}`),
          openLink: (url) => Linking.openURL(url),
        },
      ),
    [session, databaseId, router],
  );
  const [metadata, setMetadata] = useState<Awaited<
    ReturnType<typeof host.metadata>
  > | null>(null);
  useEffect(() => {
    let live = true;
    void host.prepareOpening(openingView).then(
      (data) => {
        if (live) {
          setMetadata(data);
          onTitle?.(data.db.name);
          openingTrace.mark("metadata-ready");
        }
      },
      (e) => {
        if (live) setError(e.message);
      },
    );
    void warmDatabaseSurface().catch(() => {});
    return () => {
      live = false;
      void host.releaseQueries();
    };
  }, [host, openingTrace, onTitle, openingView]);
  const [admitted, setAdmitted] = useState(!reusesDatabaseRuntime);
  const admittedRef = useRef(admitted);
  useLayoutEffect(() => {
    admittedRef.current = admitted;
  }, [admitted]);
  const rendererReady = useRef(false);
  const lease = useMemo(
    () => ({
      yield: async () => {
        if (rendererReady.current) await web.current?.closeSession?.(nonce);
        rendererReady.current = false;
        needsReopen.current = true;
        setAdmitted(false);
      },
    }),
    [nonce],
  );
  useFocusEffect(
    useCallback(() => {
      if (needsReopen.current) {
        needsReopen.current = false;
        setGeneration((g) => g + 1);
        return;
      }
      if (reusesDatabaseRuntime)
        void databaseOwner
          .acquire(lease)
          .then((ok) => {
            if (ok) setAdmitted(true);
          })
          .catch((e) => setError(e.message));
      return () => databaseOwner.cancel(lease);
    }, [lease]),
  );
  useEffect(
    () => () => {
      databaseOwner.release(lease);
    },
    [lease],
  );
  const [exitAllowed, setExitAllowed] = useState(false);
  const flushWaiters = useRef(
    new Map<
      string,
      {
        resolve(result: {
          ok: boolean;
          error?: string;
          dismissed?: boolean;
        }): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const highWater = useRef(0);
  const replies = useRef(new Map<number, Promise<unknown>>());
  useEffect(() => {
    rendererReady.current = false;
    replies.current.clear();
    highWater.current = 0;
    const waiters = flushWaiters.current;
    return () => {
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.resolve({ ok: false, error: "页面已重新加载" });
      }
      waiters.clear();
      dateRef.current?.resolve(undefined);
    };
  }, [nonce]);
  const send = useCallback(
    (message: unknown) =>
      web.current?.injectJavaScript(
        `window.__metahubDatabaseReceive?.(${scriptJSON(message)});true;`,
      ),
    [],
  );
  const lastRequestedView = useRef(initialView);
  useEffect(() => {
    if (initialView && initialView !== lastRequestedView.current)
      send({ session: nonce, type: "view", view: initialView });
    lastRequestedView.current = initialView;
  }, [initialView, nonce, send]);
  const flushRenderer = useCallback(
    (navigation = false) =>
      new Promise<{ ok: boolean; error?: string; dismissed?: boolean }>(
        (resolve) => {
          if (!admittedRef.current || !rendererReady.current) {
            resolve({ ok: true });
            return;
          }
          const token = `${Date.now()}:${Math.random()}`;
          const timer = setTimeout(() => {
            flushWaiters.current.delete(token);
            resolve({
              ok: false,
              error: "保存超时，请重试；未确认的输入仍在当前页面",
            });
          }, 15000);
          flushWaiters.current.set(token, { resolve, timer });
          send({ session: nonce, type: "flush", token, navigation });
        },
      ),
    [nonce, send],
  );
  usePreventRemove(!exitAllowed && !deleted, ({ repeat }) => {
    void flushRenderer(true).then((result) => {
      if (result.dismissed) return;
      if (result.ok) {
        void (async () => {
          await web.current?.closeSession?.(nonce);
          setExitAllowed(true);
          repeat();
        })().catch((e) => setError(e.message));
      } else
        Alert.alert("修改尚未保存", result.error, [
          { text: "留下修正", style: "cancel" },
          {
            text: "保留草稿离开",
            onPress: () => {
              setExitAllowed(true);
              repeat();
            },
          },
        ]);
    });
  });
  useEffect(
    () =>
      registerRecoveryEditor(session, () => ({
        setFrozen: (value) => send({ session: nonce, type: "freeze", value }),
        flush: flushRenderer,
      })),
    [session, nonce, send, flushRenderer],
  );
  useEffect(
    () =>
      session.replica.service.onChange((change) => {
        if (!change.databaseIds || change.databaseIds.includes(databaseId))
          send({ session: nonce, type: "changed", change });
      }),
    [session, nonce, send, databaseId],
  );
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active")
        void flushRenderer().then((result) => {
          if (!result.ok) setError(result.error ?? "保存失败");
        });
    });
    return () => listener.remove();
  }, [flushRenderer]);
  const bootstrap = useMemo(
    () =>
      scriptJSON({
        session: nonce,
        instance: String(session.id),
        workspace: session.workspaceId,
        databaseId,
        view: openingView,
        dark: initialDark,
        fontScale: initialFontScale,
        preferences: host.preferences(),
        metadata,
      }),
    [
      nonce,
      session.id,
      session.workspaceId,
      databaseId,
      openingView,
      host,
      initialDark,
      initialFontScale,
      metadata,
    ],
  );
  useEffect(() => {
    web.current?.injectJavaScript(
      `document.documentElement.dataset.resolved=${scriptJSON(scheme)};document.documentElement.dataset.fontScale=${scriptJSON(String(fontScale))};document.documentElement.style.setProperty('--database-font-scale',${scriptJSON(String(fontScale))});window.dispatchEvent(new Event('database-presentation'));true;`,
    );
  }, [scheme, fontScale]);
  return (
    <View
      style={{
        flex: 1,
        paddingTop: Platform.OS === "ios" ? headerHeight : 0,
        paddingBottom: insets.bottom,
      }}
    >
      {error ? (
        <Pressable
          onPress={() => {
            rendererReady.current = false;
            setError("");
            setGeneration((g) => g + 1);
          }}
          style={{ padding: 12 }}
        >
          <Text>{error} · 点击重新加载</Text>
        </Pressable>
      ) : null}
      {metadata && admitted && (
        <DatabaseSurface
          key={nonce}
          ref={web}
          bootstrap={bootstrap}
          onFailure={setError}
          onMessage={(raw) => {
            let message: any;
            try {
              message = JSON.parse(raw);
            } catch {
              return;
            }
            if (
              message.v !== 1 ||
              message.session !== nonce ||
              message.workspace !== session.workspaceId ||
              !Number.isSafeInteger(message.id) ||
              !Array.isArray(message.args) ||
              typeof message.method !== "string"
            )
              return;
            if (message.method === "performance") {
              if (message.args[0]?.stage === "shell-ready")
                rendererReady.current = true;
              const sample = message.args[0];
              if (
                sample?.trace === nonce &&
                sample.runtime === "web" &&
                ["shell-ready", "metadata-ready", "first-frame"].includes(
                  sample.stage,
                ) &&
                Number.isFinite(sample.elapsedMs) &&
                sample.elapsedMs >= 0
              ) {
                console.info(
                  "[database-open]",
                  JSON.stringify({
                    trace: nonce,
                    runtime: "web",
                    stage: sample.stage,
                    elapsedMs: sample.elapsedMs,
                  }),
                );
                openingTrace.mark(`web-${sample.stage}-received`);
                if (databaseBenchmark && sample.stage === "first-frame")
                  void databaseRuntimeDiagnostics().then((state) =>
                    console.info("[database-runtime]", JSON.stringify(state)),
                  );
                if (sample.stage === "shell-ready")
                  web.current?.injectJavaScript(
                    `document.documentElement.dataset.resolved=${scriptJSON(scheme)};document.documentElement.style.setProperty('--database-font-scale',${scriptJSON(String(fontScale))});window.dispatchEvent(new Event('database-presentation'));true;`,
                  );
              }
              send({ session: nonce, id: message.id, ok: true, value: null });
              return;
            }
            if (message.method === "flushed") {
              const waiter = flushWaiters.current.get(message.args[0]);
              if (waiter) {
                clearTimeout(waiter.timer);
                waiter.resolve({
                  ok: !message.args[1],
                  error: message.args[1],
                  dismissed: message.args[2] === true,
                });
                flushWaiters.current.delete(message.args[0]);
              }
              send({ session: nonce, id: message.id, ok: true, value: null });
              return;
            }
            if (message.method === "pickDate") {
              dateRef.current?.resolve(undefined);
              setDateRequest({
                value: parseDate(message.args[0]) ?? new Date(),
                resolve: (value) => {
                  send({
                    session: nonce,
                    id: message.id,
                    ok: true,
                    value:
                      value === undefined ? { cancelled: true } : { value },
                  });
                  setDateRequest(null);
                },
              });
              return;
            }
            if (message.id <= highWater.current - 256) {
              send({
                session: nonce,
                id: message.id,
                ok: false,
                error: "请求已过期，请刷新后重试",
              });
              return;
            }
            highWater.current = Math.max(highWater.current, message.id);
            let result = replies.current.get(message.id);
            if (!result) {
              result = host.call(message.method, message.args);
              replies.current.set(message.id, result);
              while (replies.current.size > 256)
                replies.current.delete(replies.current.keys().next().value!);
            }
            void result.then(
              (value) =>
                send({ session: nonce, id: message.id, ok: true, value }),
              (cause) =>
                send({
                  session: nonce,
                  id: message.id,
                  ok: false,
                  error: String(cause.message),
                }),
            );
          }}
        />
      )}
      <Modal
        visible={!!dateRequest}
        transparent
        animationType="slide"
        onRequestClose={() => dateRequest?.resolve(undefined)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "flex-end",
            backgroundColor: "#0005",
          }}
        >
          <View
            style={{
              padding: 20,
              paddingBottom: insets.bottom + 20,
              backgroundColor: tokens.bg,
            }}
          >
            {dateRequest && (
              <DateTimePicker
                value={dateRequest.value}
                mode="date"
                onChange={(_, date) => {
                  if (date)
                    setDateRequest((r) => (r ? { ...r, value: date } : r));
                }}
              />
            )}
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                paddingTop: 20,
              }}
            >
              <NativeButton
                variant="text"
                label="取消"
                hostStyle={{ minWidth: 64, minHeight: 48 }}
                onPress={() => dateRequest?.resolve(undefined)}
              />
              <NativeButton
                variant="text"
                label="清除日期"
                hostStyle={{ minWidth: 96, minHeight: 48 }}
                onPress={() => dateRequest?.resolve(null)}
              />
              <NativeButton
                label="完成"
                hostStyle={{ minWidth: 64, minHeight: 48 }}
                onPress={() => dateRequest?.resolve(toISO(dateRequest.value))}
              />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
