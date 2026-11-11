import { useEffect, useRef, useState } from "react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import { freezeAndFlushEditors } from "@/lib/editor/recovery-barrier";
import { DatabaseWebView } from "@/components/DatabaseWebView";
import { useSession } from "@/lib/auth/session";
export default function DatabaseScreen() {
  const { id, view } = useLocalSearchParams<{ id: string; view?: string }>();
  const session = useSession(),
    { workspaceId } = session,
    router = useRouter();
  const [busy, setBusy] = useState(false),
    running = useRef(false);
  const action = async (run: () => void | Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    let release: (() => void) | undefined;
    try {
      release = await freezeAndFlushEditors(session);
      if (session.isCurrent()) await run();
    } catch (e) {
      if (session.isCurrent())
        Alert.alert("操作失败", e instanceof Error ? e.message : String(e));
    } finally {
      release?.();
      running.current = false;
      setBusy(false);
    }
  };
  const share = () =>
    void action(() =>
      router.push(
        `/manage/share/${encodeURIComponent(id)}?kind=database` as Parameters<
          typeof router.push
        >[0],
      ),
    );
  const [deleted, setDeleted] = useState(false);
  useEffect(() => {
    if (deleted && session.isCurrent()) router.replace("/");
  }, [deleted, session, router]);
  const [title, setTitle] = useState("数据表");
  useEffect(() => {
    let live = true;
    const load = () =>
      void session.client
        .listDatabases()
        .then((rows) => {
          if (live)
            setTitle(rows.find((row) => row.id === id)?.name ?? "数据表");
        })
        .catch(() => {});
    const stop = session.replica.service.onChange(change => {
      if(change.datasets.includes("databases") && (!change.databaseIds || change.databaseIds.includes(id))) load();
    });
    return () => {
      live = false;
      stop();
    };
  }, [session, id]);
  return (
    <>
      <Stack.Screen options={{ title, headerBackVisible: false, headerBackButtonMenuEnabled: false }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          accessibilityLabel="返回"
          icon={process.env.EXPO_OS === "ios" ? "chevron.left" : require("@/components/native/assets/back.xml")}
          disabled={busy}
          onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/"); }}
        />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          accessibilityLabel="分享"
          icon={
            process.env.EXPO_OS === "ios"
              ? "square.and.arrow.up"
              : require("@/components/native/assets/share.xml")
          }
          disabled={busy}
          onPress={share}
        />
        <Stack.Toolbar.Menu
          title="数据表操作"
          accessibilityLabel="数据表操作"
          icon={
            process.env.EXPO_OS === "ios"
              ? "ellipsis"
              : require("@/components/native/assets/more.xml")
          }
        >
          <Stack.Toolbar.MenuAction
            disabled={busy}
            onPress={() =>
              void action(async () => {
                const copy = await session.client.duplicateDatabase(id, {
                  name: title + " 副本",
                });
                if (session.isCurrent()) router.push(`/db/${copy.id}`);
              })
            }
          >
            {"创建副本"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled={busy}
            onPress={() =>
              void action(() =>
                router.push(
                  `/manage/activity/${encodeURIComponent(id)}` as Parameters<
                    typeof router.push
                  >[0],
                ),
              )
            }
          >
            {"最近动态"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled={busy}
            onPress={() =>
              void action(async () => {
                await Clipboard.setStringAsync(id);
                Alert.alert("已复制 ID");
              })
            }
          >
            {"复制 ID"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled={busy}
            onPress={() =>
              void action(() =>
                router.push(
                  `/manage/database/${encodeURIComponent(id)}?mode=rename`,
                ),
              )
            }
          >
            {"重命名"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction disabled={busy} onPress={share}>
            {"分享"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled={busy}
            destructive
            onPress={() =>
              Alert.alert("删除数据表", `删除「${title}」及其记录？`, [
                { text: "取消", style: "cancel" },
                {
                  text: "删除",
                  style: "destructive",
                  onPress: () =>
                    void action(async () => {
                      const result = await session.client.deleteDatabase(id);
                      if (!result.ok) throw new Error("删除失败");
                      if (session.isCurrent()) setDeleted(true);
                    }),
                },
              ])
            }
          >
            {"删除数据表"}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <DatabaseWebView
        key={`${workspaceId}:${id}`}
        databaseId={id}
        initialView={view}
        onTitle={setTitle}
        deleted={deleted}
      />
    </>
  );
}
