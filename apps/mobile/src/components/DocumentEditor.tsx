import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { EditorHost, type EditorHostServices } from "../lib/editor/host";
import { editorHTML } from "../lib/editor/editor-bundle";
import { parseEditorMessage, scriptJSON, type EditorCommandResult, type EditorState } from "../lib/editor/protocol";

export interface DocumentEditorHandle {
  flush(): Promise<{ ok: boolean; error?: string }>;
  setMode(mode: "blocks" | "source"): void;
  retry(): void;
  refresh(): void;
}
export interface DocumentEditorProps {
  documentId: string;
  sessionId: string;
  host: EditorHostServices;
  dark?: boolean;
  onState?(state: EditorState): void;
  onError?(error: string): void;
}
/** The only WebView URL is this packaged shell. Native owns all persistence,
 * authenticated requests, media, and navigation. */
export const DocumentEditor = forwardRef<DocumentEditorHandle, DocumentEditorProps>(function DocumentEditor({ documentId, sessionId, host: services, dark = false, onState, onError }, ref) {
  const web = useRef<WebView>(null);
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const commands = useRef(new Map<number, { resolve(result: { ok: boolean; error?: string }): void; timer: ReturnType<typeof setTimeout> }>());
  const callbacks = useRef({ onState, onError });
  callbacks.current = { onState, onError };
  // A new nonce on every process restart prevents a late previous process
  // response from being injected into the recovered renderer.
  const nonce = useMemo(() => `${sessionId}:${documentId}:${generation}:${Date.now()}:${Math.random()}`, [sessionId, documentId, generation]);
  const servicesRef = useRef(services);
  servicesRef.current = services;
  const host = useMemo(() => new EditorHost(nonce, {
    load: () => servicesRef.current.load(),
    readDraft: () => servicesRef.current.readDraft(),
    checkpoint: draft => servicesRef.current.checkpoint(draft),
    acknowledge: (revision, version) => servicesRef.current.acknowledge(revision, version),
    save: snapshot => servicesRef.current.save(snapshot),
    listTargets: () => servicesRef.current.listTargets?.() ?? Promise.resolve([]),
    media: request => {
      if (!servicesRef.current.media) return Promise.reject(new Error("附件暂不可用"));
      return servicesRef.current.media(request);
    },
    navigate: target => {
      if (!servicesRef.current.navigate) return Promise.reject(new Error("暂时无法打开链接"));
      return servicesRef.current.navigate(target);
    },
    isCurrent: () => servicesRef.current.isCurrent(),
  }), [nonce]);
  const initialDark = useRef(dark);
  const source = useMemo(() => ({ html: editorHTML.replace("__METAHUB_BOOTSTRAP__", scriptJSON({ session: nonce, documentId, dark: initialDark.current })), baseUrl: "about:blank" }), [nonce, documentId]);
  useEffect(() => { web.current?.injectJavaScript(`document.documentElement.dataset.resolved=${scriptJSON(dark ? "dark" : "light")};true;`); }, [dark]);
  const failPending = useCallback((message: string) => {
    for (const command of commands.current.values()) { clearTimeout(command.timer); command.resolve({ ok: false, error: message }); }
    commands.current.clear();
  }, []);
  useEffect(() => () => { host.dispose(); failPending("编辑器会话已结束，草稿将保留"); }, [host, failPending]);
  const send = useCallback((method: "flush" | "mode" | "refresh", mode?: "blocks" | "source") => {
    const id = ++sequence.current;
    return new Promise<{ ok: boolean; error?: string }>(resolve => {
      const timer = setTimeout(() => { commands.current.delete(id); resolve({ ok: false, error: "编辑器没有响应，草稿将保留。请重试。" }); }, 35_000);
      commands.current.set(id, { resolve, timer });
      web.current?.injectJavaScript(`window.__metahubEditorReceive?.(${scriptJSON({ v: 1, session: nonce, type: "command", id, method, mode })});true;`);
    });
  }, [nonce]);
  const retry = useCallback(() => {
    host.dispose(); failPending("正在恢复编辑器，草稿将保留");
    setLoading(true); setError(null); setGeneration(value => value + 1);
  }, [host, failPending]);
  useImperativeHandle(ref, () => ({ flush: () => send("flush"), setMode: mode => { void send("mode", mode); }, retry, refresh: () => { void send("refresh"); } }), [send, retry]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", state => {
      if (state !== "active") void send("flush").then(result => { if (!result.ok) callbacks.current.onError?.(result.error || "保存失败，草稿将保留"); });
    });
    return () => listener.remove();
  }, [send]);
  const rendererFailed = (message: string) => {
    host.dispose(); failPending(message); setLoading(false); setError(message); callbacks.current.onError?.(message);
  };
  return <View style={[styles.root, { backgroundColor: dark ? "#171717" : "#fff" }]}>
    <WebView key={nonce} ref={web} source={source} style={styles.web} originWhitelist={["about:blank"]} javaScriptEnabled domStorageEnabled={false} allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} mixedContentMode="never" setSupportMultipleWindows={false} allowsInlineMediaPlayback keyboardDisplayRequiresUserAction={false} webviewDebuggingEnabled={__DEV__}
      onShouldStartLoadWithRequest={request => request.url === "about:blank"}
      onLoad={() => { setLoading(false); setError(null); }}
      onError={() => rendererFailed("编辑器加载失败，已保存的草稿可在重试后恢复")}
      onContentProcessDidTerminate={() => rendererFailed("编辑器进程已停止，请恢复草稿继续编辑")}
      onRenderProcessGone={() => rendererFailed("编辑器进程已停止，请恢复草稿继续编辑")}
      onMessage={event => {
        const message = parseEditorMessage(event.nativeEvent.data, nonce);
        if (!message) return;
        if (message.type === "state") { callbacks.current.onState?.(message.state); if (message.error) callbacks.current.onError?.(message.error); return; }
        if (message.type === "result") {
          const result = message as EditorCommandResult;
          const command = commands.current.get(result.id);
          if (command) { clearTimeout(command.timer); commands.current.delete(result.id); command.resolve(result); }
          return;
        }
        void host.request(message).then(response => {
          if (response) web.current?.injectJavaScript(`window.__metahubEditorReceive?.(${scriptJSON(response)});true;`);
        });
      }} />
    {loading && <View style={styles.overlay}><ActivityIndicator /></View>}
    {error && <View style={[styles.overlay, { backgroundColor: dark ? "#171717" : "#fff" }]}><Text accessibilityRole="alert" style={{ color: dark ? "#fff" : "#171717", padding: 20 }}>{error}</Text><Pressable accessibilityRole="button" onPress={retry} style={styles.button}><Text style={{ color: "#3973cb" }}>恢复草稿并重试</Text></Pressable></View>}
  </View>;
});
const styles = StyleSheet.create({ root: { flex: 1 }, web: { flex: 1, backgroundColor: "transparent" }, overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, justifyContent: "center", alignItems: "center" }, button: { padding: 16 } });
