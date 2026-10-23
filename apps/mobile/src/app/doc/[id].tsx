import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView } from "react-native-webview";

import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";

/** Document editor = WebView over the server's mobile-optimized doc page.
 *  Full CM6 block editor + block-level CRDT sync for free; native rewrite of
 *  that surface is out of scope by design (see plan).
 *
 *  Auth: navigating to /?token=<tok> makes the server set a cookie and strip
 *  the token; we also pre-seed localStorage.mh_token (the key the WebUI
 *  reads) so repeat loads and cookie-jar edge cases stay authenticated. */
export default function DocScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DocumentEditor key={id} id={id} />;
}

function DocumentEditor({ id }: { id: string }) {
  const router = useRouter();
  const { creds } = useSession();
  const { tokens, pref } = useTheme();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const webRef = useRef<WebView>(null);

  const origin = creds.baseUrl;
  const [url, setUrl] = useState(
    () =>
      `${origin}/?token=${encodeURIComponent(creds.token)}#/doc/${encodeURIComponent(id)}`,
  );
  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  };
  // Strict origin compare — a prefix test would also match e.g. :51735 when
  // the server runs on :5173.
  const sameOrigin = (u: string): boolean => {
    try {
      return new URL(u).origin === origin;
    } catch {
      return false;
    }
  };

  // Seed the WebUI's token + theme before its first script runs.
  const bootstrap = useMemo(
    () =>
      `try {
        localStorage.setItem("mh_token", ${JSON.stringify(creds.token)});
        localStorage.setItem("mh-theme", ${JSON.stringify(pref)});
      } catch (e) {}
      true;`,
    [creds.token, pref],
  );

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <Stack.Screen
        options={{
          headerShown: !loaded || !!error,
          title: "文档",
          headerLeft: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="返回"
              onPress={leave}
              hitSlop={12}
            >
              <Text style={{ color: tokens.accent }}>返回</Text>
            </Pressable>
          ),
        }}
      />
      <WebView
        ref={webRef}
        source={{ uri: url }}
        style={[styles.web, { backgroundColor: tokens.bg }]}
        injectedJavaScriptBeforeContentLoaded={bootstrap}
        onLoadStart={() => {
          setLoaded(false);
          setError(null);
        }}
        onLoad={() => setLoaded(true)}
        onError={() => {
          setLoaded(false);
          setError("文档加载失败，请检查网络后重试");
        }}
        onHttpError={({ nativeEvent }) => {
          // Only a main-document failure replaces the page; asset errors
          // must not cover an otherwise usable editor.
          if (
            nativeEvent.url.split("#")[0] !== url.split("#")[0] &&
            nativeEvent.url.split("#")[0] !== `${origin}/`
          )
            return;
          setLoaded(false);
          setError(
            nativeEvent.statusCode === 401 || nativeEvent.statusCode === 403
              ? "访问凭据已失效，请返回设置更新连接令牌"
              : `文档加载失败（${nativeEvent.statusCode}）`,
          );
        }}
        // Same-origin stays in the WebView (doclinks, hash nav); the WebUI's
        // own back arrow from a doc goes home — catch that and pop natively.
        onShouldStartLoadWithRequest={(req) => {
          if (sameOrigin(req.url)) return true;
          void Linking.openURL(req.url).catch(() => {});
          return false;
        }}
        onNavigationStateChange={(nav) => {
          if (!sameOrigin(nav.url)) return;
          const hash = nav.url.split("#")[1] ?? "";
          // Database links escape to the native db screen…
          const dbMatch = /^\/db\/([^/?]+)/.exec(hash);
          if (dbMatch) {
            router.replace(`/db/${dbMatch[1]}`);
            return;
          }
          // …and "back to home" inside the WebUI pops this native screen.
          if (loaded && !error && (hash === "/" || hash === "")) leave();
        }}
        // iOS inline media + keyboard behavior for the editor.
        allowsInlineMediaPlayback
        keyboardDisplayRequiresUserAction={false}
        webviewDebuggingEnabled={__DEV__}
      />
      {!loaded || error ? (
        <View style={[styles.loading, { backgroundColor: tokens.bg }]}>
          {error ? (
            <>
              <Text
                accessibilityRole="alert"
                style={{ color: tokens.fg, padding: 24 }}
              >
                {error}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setError(null);
                  setLoaded(false);
                  const retryUrl = `${origin}/?token=${encodeURIComponent(creds.token)}#/doc/${encodeURIComponent(id)}`;
                  if (retryUrl === url) webRef.current?.reload();
                  else setUrl(retryUrl);
                }}
                style={{ padding: 16 }}
              >
                <Text style={{ color: tokens.accent }}>重试</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={leave}
                style={{ padding: 16 }}
              >
                <Text style={{ color: tokens.accent }}>返回</Text>
              </Pressable>
            </>
          ) : (
            <ActivityIndicator color={tokens.accent} />
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  web: { flex: 1 },
  loading: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
