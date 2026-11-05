import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { WebView } from "react-native-webview";
import { editorHTML } from "../lib/editor/editor-bundle";

export interface EditorPosition { anchor: number; head: number; scroll: number; version: string | null }
export interface EditorSurfaceHandle { closeSession?(id: string): Promise<EditorPosition | null>; injectJavaScript(script: string): void }
export interface EditorSurfaceProps {
  bootstrap: string;
  onMessage(raw: string): void;
  onFailure(message: string): void;
}

export const DefaultEditorSurface = forwardRef<EditorSurfaceHandle, EditorSurfaceProps>(
  function DefaultEditorSurface({ bootstrap, onMessage, onFailure }, ref) {
    const web = useRef<WebView<unknown>>(null);
    useImperativeHandle(ref, () => ({
      injectJavaScript: script => web.current?.injectJavaScript(script),
    }), []);
    const source = useMemo(() => ({
      html: editorHTML.replace("__METAHUB_BOOTSTRAP__", () => bootstrap),
      baseUrl: "about:blank",
    }), [bootstrap]);
    return <WebView
      ref={web} source={source} style={{ flex: 1, backgroundColor: "transparent" }}
      contentInsetAdjustmentBehavior="never" originWhitelist={["about:blank"]}
      javaScriptEnabled domStorageEnabled={false} allowFileAccess={false}
      allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never" setSupportMultipleWindows={false} allowsInlineMediaPlayback
      keyboardDisplayRequiresUserAction={false} webviewDebuggingEnabled={__DEV__}
      onShouldStartLoadWithRequest={request => request.url === "about:blank"}
      onMessage={event => onMessage(event.nativeEvent.data)}
      onError={() => onFailure("编辑器加载失败，已保存的草稿可在重试后恢复")}
      onContentProcessDidTerminate={() => onFailure("编辑器进程已停止，请恢复草稿继续编辑")}
      onRenderProcessGone={() => onFailure("编辑器进程已停止，请恢复草稿继续编辑")}
    />;
  },
);
