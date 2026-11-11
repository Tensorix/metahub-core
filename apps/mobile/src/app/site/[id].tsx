import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Button, ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { WebView } from "react-native-webview";
import { getSite, getFileRow } from "../../../../../src/core/sites-core";
import { useSession } from "@/lib/auth/session";
import { useRecents } from "@/lib/navigation/use-recents";
import { serveLocalSite } from "@/lib/site/gateway";
import { siteSdk } from "@/lib/site/sdk-bundle";
import { useTheme } from "@/lib/theme";
import { useSites } from "@/lib/navigation/use-sites";

type Listener = Awaited<
  ReturnType<typeof import("@/lib/site/listener").listenSite>
>;
export default function LocalSiteScreen() {
  const [attempt, setAttempt] = useState(0);
  return <SiteViewer key={attempt} restart={() => setAttempt((n) => n + 1)} />;
}
function SiteViewer({ restart }: { restart(): void }) {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const router = useRouter();
  const { store } = useRecents();
  const { tokens } = useTheme();
  const sites = useSites();
  const publishedUrl = sites.data?.find((item) => item.id === id)?.url;
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const web = useRef<WebView<unknown>>(null);
  const headerHeight = useHeaderHeight();
  const loadedEntry = useRef(false);
  const [server, setServer] = useState<Listener | null>(null);
  const [error, setError] = useState("");
  const resources = session.siteResources;
  useSyncExternalStore(
    resources.subscribe,
    resources.snapshot,
    resources.snapshot,
  );
  const site = getSite(session.replica.db, id);
  const entry = site && getFileRow(session.replica.db, id, "");
  const mount = site ? "/sites/" + encodeURIComponent(site.name) + "/" : "";
  const hasEntry =
    entry?.content != null &&
    !!entry.content_type &&
    ["utf8", "blob", "base64"].includes(entry.encoding) &&
    (entry.encoding !== "blob" || !!resources.cached(entry.content));
  const title = site?.title || site?.name || "Site";
  const missing = site ? resources.missing(id) : [];
  useFocusEffect(
    useCallback(() => {
      let active = true,
        listener: Listener | undefined;
      loadedEntry.current = false;
      setServer(null);
      setError("");
      const end = () => {
        active = false;
        listener?.close();
        listener = undefined;
      };
      const unsubscribe = session.onSiteSessionEnd(end);
      const current = () => active && session.isCurrent();
      if (session.authInvalid) setError("工作区授权已失效");
      if (hasEntry && !session.authInvalid)
        void import("@/lib/site/listener")
          .then((mod) =>
            current()
              ? mod.listenSite(mount, current, (method, target, body) => {
                  const result = serveLocalSite(
                    session.replica.service,
                    id,
                    method,
                    target,
                    body,
                    siteSdk,
                    resources.cached,
                  );
                  if (method === "GET" && target === mount)
                    loadedEntry.current = result.status === 200;
                  return result;
                })
              : null,
          )
          .then((result) => {
            if (!result) return;
            if (!current()) {
              result.close();
              return;
            }
            listener = result;
            setServer(result);
          })
          .catch((e) => {
            if (current()) setError(String(e));
          });
      return () => {
        unsubscribe();
        end();
      };
    }, [session, hasEntry, mount, id, resources]),
  );
  const retry = async () => {
    try {
      await session.syncNow();
    } catch {
      /* Cached resources remain usable offline. */
    }
    if (!session.isCurrent()) return;
    await resources.prepare();
    if (session.isCurrent()) restart();
  };
  const action = async (run: () => unknown | Promise<unknown>) => {
    if (running.current || !session.isCurrent()) return;
    running.current = true;
    setBusy(true);
    try {
      await run();
    } catch (e) {
      if (session.isCurrent())
        Alert.alert("操作失败", e instanceof Error ? e.message : String(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <Stack.Screen
        options={{
          title,
          headerTransparent: true,
          headerShadowVisible: false,
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          title="站点操作"
          accessibilityLabel="站点操作"
          icon={
            process.env.EXPO_OS === "ios"
              ? "ellipsis"
              : require("@/components/native/assets/more.xml")
          }
        >
          <Stack.Toolbar.MenuAction
            disabled={busy || !site}
            onPress={() => router.push(`/manage/site/${encodeURIComponent(id)}` as Parameters<typeof router.push>[0])}
          >
            {"配置详情"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled={busy || !site}
            onPress={() => void action(() => {
              if (server && !error) web.current?.reload();
              else restart();
            })}
          >
            {"刷新站点"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled={busy || !site}
            onPress={() => void action(retry)}
          >
            {"同步并重新加载"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled={busy || !site}
            onPress={() => void action(async () => {
              await Clipboard.setStringAsync(id);
              if (session.isCurrent()) Alert.alert("已复制 ID");
            })}
          >
            {"复制 ID"}
          </Stack.Toolbar.MenuAction>
          {publishedUrl ? (
            <Stack.Toolbar.MenuAction
              disabled={busy}
              onPress={() => void action(() => WebBrowser.openBrowserAsync(publishedUrl))}
            >
              {"打开发布版"}
            </Stack.Toolbar.MenuAction>
          ) : null}
          {publishedUrl ? (
            <Stack.Toolbar.MenuAction
              disabled={busy}
              onPress={() => void action(async () => {
                await Clipboard.setStringAsync(publishedUrl);
                if (session.isCurrent()) Alert.alert("已复制发布链接");
              })}
            >
              {"复制发布链接"}
            </Stack.Toolbar.MenuAction>
          ) : null}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      {(!hasEntry || error || missing.length > 0) && (
        <View style={{ padding: 12, paddingTop: headerHeight + 12, gap: 6 }}>
          <Text style={{ color: tokens.fg }}>
            {error ||
              (!site
                ? "站点已删除"
                : !hasEntry
                  ? "入口文件尚未同步"
                  : "正在准备资源")}
          </Text>
          <ScrollView style={{ maxHeight: 140 }}>
            {missing.map((file) => (
              <Text key={file.path} style={{ color: tokens.fgSoft }}>
                {file.path}
                {file.error ? " · " + file.error : ""}
              </Text>
            ))}
          </ScrollView>
          {site && (
            <Button
              title="重试"
              disabled={busy}
              onPress={() => void action(retry)}
            />
          )}
        </View>
      )}
      {server && (
        <WebView
          ref={web}
          key={server.url}
          source={{ uri: server.url }}
          contentInsetAdjustmentBehavior="automatic"
          incognito
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          setSupportMultipleWindows={false}
          originWhitelist={["*"]}
          onShouldStartLoadWithRequest={(req) =>
            req.url.startsWith(server.origin + "/")
          }
          onLoad={(event) => {
            if (
              session.isCurrent() &&
              event.nativeEvent.url === server.origin + mount &&
              loadedEntry.current
            )
              store.remember({ id, kind: "site", title });
          }}
          onHttpError={(event) => {
            if (event.nativeEvent.url === server.origin + mount)
              setError("站点首页加载失败");
          }}
          onError={() => setError("本机站点连接失败")}
        />
      )}
    </View>
  );
}
