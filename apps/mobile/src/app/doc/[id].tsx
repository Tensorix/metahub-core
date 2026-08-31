import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, StyleSheet, View } from "react-native";
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
  const router = useRouter();
  const { creds } = useSession();
  const { tokens, pref } = useTheme();
  const [loaded, setLoaded] = useState(false);
  const webRef = useRef<WebView>(null);

  const origin = creds.baseUrl;
  const url = `${origin}/?token=${encodeURIComponent(creds.token)}#/doc/${id}`;
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
      {/* The WebUI mobile doc page brings its own back-arrow topbar; keep the
          native header hidden to avoid a double chrome. */}
      <Stack.Screen options={{ headerShown: false }} />
      <WebView
        ref={webRef}
        source={{ uri: url }}
        style={[styles.web, { backgroundColor: tokens.bg }]}
        injectedJavaScriptBeforeContentLoaded={bootstrap}
        onLoadEnd={() => setLoaded(true)}
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
          if (loaded && (hash === "/" || hash === "")) router.back();
        }}
        // iOS inline media + keyboard behavior for the editor.
        allowsInlineMediaPlayback
        keyboardDisplayRequiresUserAction={false}
        webviewDebuggingEnabled={__DEV__}
      />
      {!loaded ? (
        <View style={[styles.loading, { backgroundColor: tokens.bg }]}>
          <ActivityIndicator color={tokens.accent} />
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
