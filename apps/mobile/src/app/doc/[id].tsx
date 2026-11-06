import { documentOwner, type DocumentLease } from "@/lib/editor/session-owner";
import { reusesEditorRuntime } from "@/lib/editor/warmup";
import type { EditorPosition } from "@/components/DefaultEditorSurface";
import { registerRecoveryEditor } from "@/lib/editor/recovery-barrier";
import { useFocusEffect, useNavigation, Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useHeaderHeight, usePreventRemove } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Linking, Platform, StyleSheet, Text, View } from "react-native";
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
  const headerHeight = useHeaderHeight();
  const [mode, setMode] = useState<"blocks" | "source">("blocks");
  const editor = useRef<DocumentEditorHandle>(null);
  const [position, setPosition] = useState<EditorPosition | null>(null);
  const [admitted, setAdmitted] = useState(!reusesEditorRuntime);
  const phase = useRef<"active" | "deleting" | "deleted">("active");
  const navigating = useRef(false);
  const pendingLink = useRef<{ path: string; completion: Promise<void> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [exitAllowed, setExitAllowed] = useState(false);
  // Re-arm if a parent prevents the replay and this screen stays mounted.
  useEffect(() => {
    if (!exitAllowed) return;
    const frame = requestAnimationFrame(() => setExitAllowed(false));
    return () => cancelAnimationFrame(frame);
  }, [exitAllowed]);
  const [history, setHistory] = useState(false);
  const [title, setTitle] = useState("文档");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => !admitted ? undefined : registerRecoveryEditor(session.replica, () => editor.current), [session, admitted]);
  const detach = useCallback(async () => {
    const saved = await editor.current?.closeSession();
    if (saved === undefined) return;
    setPosition(saved);
    setAdmitted(false);
  }, []);
  const isCurrent = session.isCurrent;
  const lease = useMemo<DocumentLease>(() => ({
    async yield() {
      const current = editor.current;
      if (!current || !isCurrent()) return;
      try {
        await withFlushedDocument(current, isCurrent, detach);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }
    },
  }), [isCurrent, detach]);
  useEffect(() => () => documentOwner.release(lease), [lease]);
  const acquire = useCallback(() => {
    if (!reusesEditorRuntime) return;
    void documentOwner.acquire(lease).then(ok => {
      if (ok && navigation.isFocused()) setAdmitted(true);
    }, error => {
      if (navigation.isFocused()) {
        setError(error instanceof Error ? error.message : String(error));
        if (router.canGoBack()) router.back();
      }
    });
  }, [lease, navigation, router]);
  useFocusEffect(useCallback(() => {
    acquire();
    return () => documentOwner.cancel(lease);
  }, [lease, acquire]));
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
      else router.replace("/");
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
  usePreventRemove(admitted && !deleted && !exitAllowed, ({ repeat }) => {
    if (navigating.current || phase.current !== "active") return;
    void runAction(async () => {
      await detach();
      setExitAllowed(true);
      repeat();
      requestAnimationFrame(() => { if (navigation.isFocused()) acquire(); });
    }).catch((e) => {
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
        const match = /^(?:#)?\/(doc|db|rec)\/([^/?#]+)$/.exec(target);
        if (match) {
          const route = match[1] === "rec" ? "record" : match[1];
          const path = "/" + route + "/" + encodeURIComponent(decodeURIComponent(match[2]!));
          if (pendingLink.current) {
            pendingLink.current.path = path;
            return pendingLink.current.completion;
          }
          const link = { path, completion: Promise.resolve() };
          pendingLink.current = link;
          link.completion = runAction(async () => {
            check();
            await detach();
            check();
            router.push(link.path as Parameters<typeof router.push>[0]);
          }).catch(error => { if (navigation.isFocused()) acquire(); throw error; }).finally(() => {
            pendingLink.current = null;
          });
          return link.completion;
        }
        await runAction(async () => {
          check();
          if (target.startsWith("/blob/")) {
            await session.attachments.media(
              { action: "preview", src: target },
              present,
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
  }, [id, router, session, recent, runAction, detach, navigation, acquire]);
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
    else router.replace("/");
  };

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: tokens.bg }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={headerHeight}>
      <Stack.Screen options={{ title, headerBackButtonMenuEnabled: false }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          accessibilityLabel="返回"
          icon={
            process.env.EXPO_OS === "ios"
              ? "chevron.left"
              : require("@/components/native/assets/back.xml")
          }
          disabled={busy}
          onPress={leave}
        />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          title="文档操作"
          accessibilityLabel="文档操作"
          icon={
            process.env.EXPO_OS === "ios"
              ? "ellipsis"
              : require("@/components/native/assets/more.xml")
          }
        >
          <Stack.Toolbar.MenuAction disabled={busy || !admitted} onPress={() => setMode(value => value === "blocks" ? "source" : "blocks")}>
            {mode === "blocks" ? "代码方式显示" : "块方式显示"}
          </Stack.Toolbar.MenuAction>
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
      {admitted && !deleted && (
        <DocumentEditor
          ref={editor}
          documentId={id}
          position={position}
          workspaceId={session.workspaceId}
          sessionId={String(session.id)}
          host={host}
          dark={scheme === "dark"}
          mode={mode}
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
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({ root: { flex: 1 } });
