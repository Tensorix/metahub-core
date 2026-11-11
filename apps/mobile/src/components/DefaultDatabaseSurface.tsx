import { File, Paths } from "expo-file-system";
import { databaseBenchmarkBaseline } from "@/lib/diagnostics/database-mode";
import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { WebView } from "react-native-webview";
import { databaseHTML } from "@/lib/database/bundle";
export interface DatabaseSurfaceHandle {
  injectJavaScript(script: string): void;
  closeSession?(id: string): Promise<unknown>;
}
export interface DatabaseSurfaceProps {
  bootstrap: string;
  onMessage(raw: string): void;
  onFailure(message: string): void;
}
export const DefaultDatabaseSurface = forwardRef<
  DatabaseSurfaceHandle,
  DatabaseSurfaceProps
>(function DefaultDatabaseSurface({ bootstrap, onMessage, onFailure }, ref) {
  const web = useRef<WebView<unknown>>(null);
  useImperativeHandle(
    ref,
    () => ({
      injectJavaScript: (script) => web.current?.injectJavaScript(script),
    }),
    [],
  );
  const source = useMemo(
    () => ({
      html: (databaseBenchmarkBaseline
        ? new File(Paths.document, "database-baseline.html").textSync()
        : databaseHTML
      ).replace("__METAHUB_BOOTSTRAP__", () => bootstrap),
      baseUrl: "about:blank",
    }),
    [bootstrap],
  );
  return (
    <WebView
      ref={web}
      source={source}
      style={{ flex: 1, backgroundColor: "transparent" }}
      originWhitelist={["about:blank"]}
      javaScriptEnabled
      domStorageEnabled={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never"
      setSupportMultipleWindows={false}
      hideKeyboardAccessoryView
      keyboardDisplayRequiresUserAction={false}
      contentInsetAdjustmentBehavior="never"
      onShouldStartLoadWithRequest={(r) => r.url === "about:blank"}
      onMessage={(e) => onMessage(e.nativeEvent.data)}
      onError={() => onFailure("数据表加载失败")}
      onContentProcessDidTerminate={() =>
        onFailure("数据表进程已停止，请重试恢复已保存草稿")
      }
      onRenderProcessGone={() =>
        onFailure("数据表进程已停止，请重试恢复已保存草稿")
      }
    />
  );
});
