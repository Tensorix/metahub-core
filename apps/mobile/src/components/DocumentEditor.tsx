import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { EditorSurface } from "./EditorSurface";
import { DocumentToolbar } from "./DocumentToolbar";
import type { EditorPosition, EditorSurfaceHandle } from "./DefaultEditorSurface";
import { EditorHost, type EditorHostServices } from "../lib/editor/host";
import { createNativePresentationGuard } from "../lib/editor/native-presentation";
import {
  parseEditorMessage,
  scriptJSON,
  type EditorBlockType,
  type EditorFormatType,
  type EditorCommandResult,
  type EditorState,
  type EditorDraft,
} from "../lib/editor/protocol";

export interface DocumentEditorHandle {
  setFrozen(frozen: boolean): void;
  flush(): Promise<{ ok: boolean; error?: string }>;
  closeSession(): Promise<EditorPosition | null | undefined>;
  retry(): void;
  refresh(): void;
}
export interface DocumentEditorProps {
  documentId: string;
  sessionId: string;
  workspaceId: string;
  host: EditorHostServices;
  position?: EditorPosition | null;
  dark?: boolean;
  mode?: "blocks" | "source";
  onState?(state: EditorState): void;
  onError?(error: string): void;
}
/** The only WebView URL is this packaged shell. Native owns all persistence,
 * authenticated requests, media, and navigation. */
export const DocumentEditor = forwardRef<
  DocumentEditorHandle,
  DocumentEditorProps
>(function DocumentEditor(
  { documentId, sessionId, workspaceId, position, host: services, dark = false, mode = "blocks", onState, onError },
  ref,
) {
  const web = useRef<EditorSurfaceHandle>(null);
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<EditorState>("saved");
  const [controlsFrozen, setControlsFrozen] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const attachmentPending = useRef(false);
  const sequence = useRef(0);
  const frozen = useRef(false);
  const freezeDepth = useRef(0);
  const closing = useRef<{ nonce: string; result: Promise<EditorPosition | null> } | null>(null);
  const commands = useRef(
    new Map<
      number,
      {
        resolve(result: { ok: boolean; error?: string }): void;
        timer: ReturnType<typeof setTimeout>;
        deliver?: () => void;
      }
    >(),
  );
  const callbacks = useRef({ onState, onError });
  callbacks.current = { onState, onError };
  // A new nonce on every process restart prevents a late previous process
  // response from being injected into the recovered renderer.
  const nonce = useMemo(
    () =>
      `${sessionId}:${documentId}:${generation}:${Date.now()}:${Math.random()}`,
    [sessionId, documentId, generation],
  );
  const rendererNonce = useRef(nonce);
  rendererNonce.current = nonce;
  const presentationRef = useRef<ReturnType<
    typeof createNativePresentationGuard
  > | null>(null);
  const servicesRef = useRef(services);
  servicesRef.current = services;
  const host = useMemo(
    () =>
      new EditorHost(nonce, {
        load: () => servicesRef.current.load(),
        readDraft: () => servicesRef.current.readDraft(),
        checkpoint: (draft) => servicesRef.current.checkpoint(draft),
        acknowledge: (revision, version) =>
          servicesRef.current.acknowledge(revision, version),
        save: (snapshot) => servicesRef.current.save(snapshot),
        listTargets: () =>
          servicesRef.current.listTargets?.() ?? Promise.resolve([]),
        media: (request) => {
          const currentServices = servicesRef.current;
          if (!currentServices.media)
            return Promise.reject(new Error("附件暂不可用"));
          const guard = presentationRef.current;
          if (!guard) return Promise.reject(new Error("编辑器尚未就绪"));
          // The manager calls this only at its actual picker/share API. The
          // renderer remains background-saveable while bytes are transferred.
          return currentServices.media(request, (open) => guard.run(open));
        },
        navigate: (target) => {
          const currentServices = servicesRef.current;
          if (!currentServices.navigate)
            return Promise.reject(new Error("暂时无法打开链接"));
          const guard = presentationRef.current;
          if (!guard) return Promise.reject(new Error("编辑器尚未就绪"));
          return currentServices.navigate(target, (open) => guard.run(open));
        },
        isCurrent: () => servicesRef.current.isCurrent(),
      }),
    [nonce],
  );
  const [initial, setInitial] = useState<(EditorDraft & { recovered: boolean }) | null>(null);
  const ready = useRef(false);
  const failedRenderer = useRef(false);
  const needsRefresh = useRef(false);
  useEffect(() => {
    let active = true;
    void host.openDocument().then(doc => {
      if (active) setInitial(doc);
    }, cause => {
      if (!active) return;
      setLoading(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [host]);
  const initialDark = useRef(dark);
  const bootstrap = useMemo(() => initial && scriptJSON({
    session: nonce, workspace: workspaceId, instance: sessionId, documentId, position, dark: initialDark.current, initial,
  }), [nonce, documentId, initial, workspaceId, sessionId, position]);
  useEffect(() => {
    web.current?.injectJavaScript(
      `document.documentElement.dataset.resolved=${scriptJSON(dark ? "dark" : "light")};true;`,
    );
  }, [dark]);
  const failPending = useCallback((message: string) => {
    for (const command of commands.current.values()) {
      clearTimeout(command.timer);
      command.resolve({ ok: false, error: message });
    }
    commands.current.clear();
  }, []);
  useEffect(
    () => () => {
      host.dispose();
      failPending("编辑器会话已结束，草稿将保留");
    },
    [host, failPending],
  );
  const send = useCallback(
    (method: "flush" | "mode" | "refresh" | "retry" | "attach" | "block" | "format", mode?: "blocks" | "source", kind?: "library" | "image" | "video" | "audio" | "file", block?: EditorBlockType, format?: EditorFormatType) => {
      const id = ++sequence.current;
      return new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const timer = setTimeout(() => {
          commands.current.delete(id);
          resolve({ ok: false, error: "编辑器没有响应，草稿将保留。请重试。" });
        }, method === "attach" ? 11 * 60_000 : 35_000);
        const deliver = () => web.current?.injectJavaScript(
          `window.__metahubEditorReceive?.(${scriptJSON({ v: 1, session: nonce, type: "command", id, method, mode, kind, block, format })});true;`,
        );
        commands.current.set(id, { resolve, timer, deliver: ready.current ? undefined : deliver });
        if (ready.current) deliver();
      });
    },
    [nonce],
  );
  useEffect(() => {
    if (!ready.current || loading) return;
    let current = true;
    void send("mode", mode).then(result => {
      if (current && !result.ok) callbacks.current.onError?.(result.error ?? "切换模式失败");
    });
    return () => { current = false; };
  }, [mode, loading, nonce, send]);
  const attach = async (kind: "library" | "image" | "video" | "audio" | "file") => {
    if (!ready.current || frozen.current || attachmentPending.current) return;
    attachmentPending.current = true;
    setAttaching(true);
    const result = await send("attach", undefined, kind);
    if (rendererNonce.current !== nonce) return;
    attachmentPending.current = false;
    setAttaching(false);
    if (!result.ok) callbacks.current.onError?.(result.error ?? "插入附件失败");
  };
  useEffect(() => {
    attachmentPending.current = false;
    setAttaching(false);
  }, [nonce]);
  const presentation = useMemo(
    () =>
      createNativePresentationGuard(
        () => send("flush"),
        () =>
          rendererNonce.current === nonce && servicesRef.current.isCurrent(),
        () => AppState.currentState === "active",
      ),
    [nonce, send],
  );
  presentationRef.current = presentation;
  useEffect(() => () => presentation.dispose(), [presentation]);
  const retry = useCallback(() => {
    if (ready.current && !failedRenderer.current) {
      void send("retry").then(result => { if (!result.ok) callbacks.current.onError?.(result.error || "保存失败"); });
      return;
    }
    failedRenderer.current = false;
    presentationRef.current?.dispose();
    host.dispose();
    failPending("正在恢复编辑器，草稿将保留");
    ready.current = false;
    setInitial(null);
    setLoading(true);
    setError(null);
    setGeneration((value) => value + 1);
  }, [host, failPending, send]);
  useImperativeHandle(
    ref,
    () => ({
      setFrozen: (value) => {
        freezeDepth.current = Math.max(0, freezeDepth.current + (value ? 1 : -1));
        value = freezeDepth.current > 0;
        if (frozen.current === value) return;
        frozen.current = value;
        setControlsFrozen(value);
        web.current?.injectJavaScript(
          `window.__metahubSetFrozen?.(${scriptJSON(nonce)},${value});true;`,
        );
      },
      flush: () => send("flush"),
      closeSession: async () => {
        if (closing.current?.nonce === nonce) return closing.current.result;
        const result = web.current?.closeSession?.(nonce);
        if (!result) return undefined;
        closing.current = { nonce, result };
        try { return await result; }
        catch (error) {
          if (closing.current?.result === result) closing.current = null;
          throw error;
        }
      },
      retry,
      refresh: () => {
        if (ready.current) void send("refresh");
        else needsRefresh.current = true;
      },
    }),
    [send, retry, nonce],
  );
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !presentation.isPresenting())
        void send("flush").then((result) => {
          if (!result.ok)
            callbacks.current.onError?.(result.error || "保存失败，草稿将保留");
        });
    });
    return () => listener.remove();
  }, [send, presentation]);
  const rendererFailed = (message: string) => {
    if (rendererNonce.current !== nonce) return;
    failedRenderer.current = true;
    presentationRef.current?.dispose();
    host.dispose();
    failPending(message);
    setLoading(false);
    setError(message);
    callbacks.current.onError?.(message);
  };
  const receive = (raw: string) => {
    if (rendererNonce.current !== nonce) return;
    const message = parseEditorMessage(raw, nonce);
    if (!message) return;
    if (message.type === "ready") {
      ready.current = true;
      if (frozen.current) web.current?.injectJavaScript(`window.__metahubSetFrozen?.(${scriptJSON(nonce)},true);true;`);
      for (const command of commands.current.values()) {
        command.deliver?.();
        command.deliver = undefined;
      }
      setLoading(false);
      if (needsRefresh.current) {
        needsRefresh.current = false;
        void send("refresh");
      }
      return;
    }
    if (message.type === "state") {
      setSaveState(message.state);
      if (message.state === "error" && !ready.current) {
        setLoading(false);
        failPending(message.error || "编辑器加载失败");
      }
      callbacks.current.onState?.(message.state);
      if (message.error) callbacks.current.onError?.(message.error);
      return;
    }
    if (message.type === "result") {
      const result = message as EditorCommandResult;
      const command = commands.current.get(result.id);
      if (command) {
        clearTimeout(command.timer);
        commands.current.delete(result.id);
        command.resolve(result);
      }
      return;
    }
    void host.request(message).then((response) => {
      if (response)
        web.current?.injectJavaScript(
          `window.__metahubEditorReceive?.(${scriptJSON(response)});true;`,
        );
    });
  };
  return (
    <View style={[styles.root, { backgroundColor: dark ? "#171717" : "#fff" }]}>
      {bootstrap && <EditorSurface key={nonce} ref={web} bootstrap={bootstrap}
        onMessage={receive} onFailure={rendererFailed} />}
      <DocumentToolbar state={saveState} disabled={loading || !!error || controlsFrozen || attaching}
        onAttach={kind => void attach(kind)}
        onFormat={format => { void send("format", undefined, undefined, undefined, format).then(result => { if (!result.ok) callbacks.current.onError?.(result.error || "格式设置失败"); }); }}
        onBlock={block => { void send("block", undefined, undefined, block).then(result => { if (!result.ok) callbacks.current.onError?.(result.error || "插入失败"); }); }} />
      {loading && (
        <View pointerEvents="none" accessibilityLabel="正在打开文档" style={[StyleSheet.absoluteFill, styles.skeleton]}>
          <View style={[styles.skeletonTitle, { backgroundColor: dark ? "#383838" : "#e9e9e9" }]} />
          <View style={[styles.skeletonLine, { backgroundColor: dark ? "#292929" : "#f2f2f2" }]} />
        </View>
      )}
      {error && (
        <View
          style={[
            styles.overlay,
            { backgroundColor: dark ? "#171717" : "#fff" },
          ]}
        >
          <Text
            accessibilityRole="alert"
            style={{ color: dark ? "#fff" : "#171717", padding: 20 }}
          >
            {error}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={retry}
            style={styles.button}
          >
            <Text style={{ color: "#3973cb" }}>恢复草稿并重试</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
});
const styles = StyleSheet.create({
  root: { flex: 1 },
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: "center",
    alignItems: "center",
  },
  skeleton: { paddingHorizontal: 16, paddingTop: 18 },
  skeletonTitle: { width: "45%", height: 18, borderRadius: 4, marginBottom: 16 },
  skeletonLine: { width: "75%", height: 12, borderRadius: 4 },
  button: { padding: 16 },
});
