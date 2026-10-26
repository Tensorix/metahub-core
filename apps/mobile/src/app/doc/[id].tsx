import { NativeToolbarAction } from "@/components/native/NativeToolbarAction";
import {
  Stack,
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, StyleSheet, Text, View } from "react-native";
import {
  DocumentEditor,
  type DocumentEditorHandle,
} from "@/components/DocumentEditor";
import { DocumentHistorySheet } from "@/components/DocumentHistorySheet";
import { NativeButton } from "@/components/native/NativeButton";
import { useLiveInvalidate } from "@/lib/api/hooks";
import { useSession } from "@/lib/auth/session";
import type { EditorHostServices } from "@/lib/editor/host";
import {
  deleteFlushedDocument,
  withFlushedDocument,
} from "@/lib/document-actions";
import { createRecentStore } from "@/lib/navigation/recent";
import { useTheme } from "@/lib/theme";

export default function DocScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  return <LocalDocument key={session.id + ":" + id} id={id} />;
}
function LocalDocument({ id }: { id: string }) {
  const session = useSession();
  const router = useRouter();
  const navigation = useNavigation();
  const { tokens, scheme } = useTheme();
  const editor = useRef<DocumentEditorHandle>(null);
  const phase = useRef<"active" | "deleting" | "deleted">("active");
  const navigating = useRef(false);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [history, setHistory] = useState(false);
  const [title, setTitle] = useState("文档");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recent = useMemo(
    () => createRecentStore(session.replica.db, session.workspaceId),
    [session.replica, session.workspaceId],
  );
  useLiveInvalidate(["documents", "doc_blocks"], () => {
    if (phase.current !== "active") return;
    editor.current?.refresh();
  });
  useEffect(() => {
    if (deleted) {
      if (router.canGoBack()) router.back();
      else router.replace("/(tabs)");
    }
  }, [deleted, router]);
  const runAction = useCallback(
    async (run: () => void | Promise<void>) => {
      if (navigating.current || phase.current !== "active")
        throw new Error("文档操作尚未完成，请稍后重试");
      navigating.current = true;
      setBusy(true);
      setError(null);
      try {
        if (!editor.current) throw new Error("编辑器尚未就绪，请稍后重试");
        await withFlushedDocument(editor.current, session.isCurrent, run);
      } finally {
        navigating.current = false;
        if ((phase.current as string) !== "deleted") setBusy(false);
      }
    },
    [session.isCurrent],
  );
  usePreventRemove(!deleted, ({ data }) => {
    if (navigating.current || phase.current !== "active") return;
    void runAction(() => navigation.dispatch(data.action)).catch((e) => {
      if (session.isCurrent())
        setError(e instanceof Error ? e.message : String(e));
    });
  });
  const host = useMemo<EditorHostServices>(() => {
    const check = () => {
      if (!session.isCurrent() || phase.current !== "active")
        throw new Error("文档编辑已暂停");
    };
    const drafts = session.replica.service.drafts;
    return {
      isCurrent: () => session.isCurrent() && phase.current === "active",
      async load() {
        check();
        const doc = await session.client.getDocument(id);
        check();
        setTitle(doc.title || "未命名");
        try {
          recent.remember({
            id,
            kind: "document",
            title: doc.title || "未命名",
          });
        } catch {}
        return {
          title: doc.title ?? "",
          body: doc.body ?? "",
          version: doc.version ?? null,
        };
      },
      async readDraft() {
        check();
        return drafts.readDocument(id);
      },
      async checkpoint(draft) {
        check();
        drafts.checkpointDocument(id, draft);
      },
      async acknowledge(revision, version) {
        check();
        drafts.acknowledgeDocument(id, revision, version ?? undefined);
      },
      async save(snapshot) {
        check();
        const doc = await session.client.updateDocument(id, {
          title: snapshot.title,
          body: snapshot.body,
          ...(!snapshot.force && snapshot.version !== null
            ? { if_match: snapshot.version }
            : {}),
        });
        check();
        setTitle(doc.title || "未命名");
        try {
          recent.remember({
            id,
            kind: "document",
            title: doc.title || "未命名",
          });
        } catch {}
        void session.syncNow().catch(() => {});
        return { version: doc.version ?? null };
      },
      async listTargets() {
        check();
        const [docs, databases] = await Promise.all([
          session.client.queryDocuments({ limit: 60 }),
          session.client.listDatabases(),
        ]);
        check();
        return [
          ...docs.documents.map((d) => ({
            id: d.id,
            title: d.title,
            kind: "doc" as const,
          })),
          ...databases.map((d) => ({
            id: d.id,
            title: d.name,
            kind: "db" as const,
          })),
        ];
      },
      media: (request, present) => {
        check();
        return session.attachments.media(request, present);
      },
      async navigate(target, present) {
        await runAction(async () => {
          check();
          if (target.startsWith("/blob/")) {
            await session.attachments.media({ action: "preview", src: target }, present);
            return;
          }
          const match = /^(?:#)?\/(doc|db|rec)\/([^/?#]+)$/.exec(target);
          if (match) {
            const route = match[1] === "rec" ? "record" : match[1];
            router.push(
              ("/" +
                route +
                "/" +
                encodeURIComponent(
                  decodeURIComponent(match[2]!),
                )) as Parameters<typeof router.push>[0],
            );
            return;
          }
          if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target)) {
            await Linking.openURL(target);
            return;
          }
          throw new Error("此链接无法在移动端打开");
        });
      },
    };
  }, [id, router, session, recent, runAction]);
  const action = async (run: () => void | Promise<void>) => {
    try {
      await runAction(run);
    } catch (e) {
      if (session.isCurrent())
        setError(e instanceof Error ? e.message : String(e));
    }
  };
  const manage = (mode: string) =>
    void action(() =>
      router.push(
        ("/manage/document/" +
          encodeURIComponent(id) +
          "?mode=" +
          mode) as Parameters<typeof router.push>[0],
      ),
    );
  const deleteDocument = () =>
    Alert.alert(
      "删除文档",
      "删除后，子文档会移到根目录。此文档的本地恢复草稿只在删除成功后清除。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除",
          style: "destructive",
          onPress: () =>
            void action(async () => {
              await deleteFlushedDocument({
                pause: () => {
                  phase.current = "deleting";
                },
                commit: () => session.client.deleteDocument(id),
                discardDraft: () =>
                  session.replica.service.drafts.discardDocument(id),
                deleted: () => {
                  phase.current = "deleted";
                  try {
                    recent.forget("document", id);
                  } catch {}
                  setDeleted(true);
                },
                resume: () => {
                  phase.current = "active";
                  editor.current?.retry();
                },
              });
            }),
        },
      ],
    );
  const downloadAttachments = () =>
    void action(async () => {
      setNotice("正在下载附件…");
      const doc = await session.client.getDocument(id);
      const sources = [
        ...new Set(
          (doc.body ?? "").match(
            /\/blob\/[a-f0-9]{16,64}(?:\.[a-z0-9]{1,12})?/g,
          ) ?? [],
        ),
      ];
      for (const src of sources) {
        await session.attachments.cache(src);
        if (!session.isCurrent()) return;
      }
      setNotice("已保留 " + sources.length + " 个附件，可离线打开");
    });
  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  };

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <Stack.Screen options={{ title, headerBackButtonMenuEnabled: false }} />
      <NativeToolbarAction
        placement="left"
        label="返回"
        disabled={busy}
        onPress={leave}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          title="文档操作"
          accessibilityLabel="文档操作"
          icon={process.env.EXPO_OS === "ios" ? "ellipsis.circle" : require("@/components/native/assets/more.xml")}
        >
          <Stack.Toolbar.MenuAction
            disabled={busy}
            destructive={false}
            onPress={() => manage("rename")}
          >
            {"重命名"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled={busy}
            destructive={false}
            onPress={() => manage("child")}
          >
            {"新建子文档"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled={busy}
            destructive={false}
            onPress={() => manage("copy")}
          >
            {"复制文档"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled={busy}
            destructive={false}
            onPress={() => manage("move")}
          >
            {"移动文档"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled={busy}
            destructive={false}
            onPress={() => void action(() => setHistory(true))}
          >
            {"版本历史"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled={busy}
            destructive={false}
            onPress={downloadAttachments}
          >
            {"离线附件"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled={busy}
            destructive={true}
            onPress={deleteDocument}
          >
            {"删除文档"}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      {!!notice && (
        <Text
          role="status"
          selectable
          style={{ color: tokens.fg, padding: 12 }}
        >
          {notice}
        </Text>
      )}
      {!!error && (
        <View style={{ padding: 12 }}>
          <Text
            selectable
            accessibilityRole="alert"
            style={{ color: tokens.danger }}
          >
            {error}（草稿已保留）
          </Text>
          <NativeButton
            variant="text"
            onPress={() => {
              setError(null);
              editor.current?.retry();
            }}
          >
            恢复草稿并重试
          </NativeButton>
        </View>
      )}
      {!deleted && (
        <DocumentEditor
          ref={editor}
          documentId={id}
          sessionId={String(session.id)}
          host={host}
          dark={scheme === "dark"}
          onError={(message) => {
            if (phase.current === "active") setError(message);
          }}
          onState={(state) => {
            if (phase.current === "active" && state === "saved") setError(null);
          }}
        />
      )}
      {history && (
        <DocumentHistorySheet
          documentId={id}
          visible={history}
          onClose={() => setHistory(false)}
          onReverted={() => {
            editor.current?.refresh();
          }}
        />
      )}
    </View>
  );
}
const styles = StyleSheet.create({ root: { flex: 1 } });
