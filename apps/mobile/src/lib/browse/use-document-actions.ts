import { useMemo, useRef } from "react";
import { Alert, AccessibilityInfo, Platform, ToastAndroid } from "react-native";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useSession } from "../auth/session";
import { createRecentStore } from "../navigation/recent";
import { freezeAndFlushEditors } from "../editor/recovery-barrier";
import { deleteListedDocument } from "../document-actions";
import { readDocumentMenu, type DocumentMenuAction } from "./document-menu";

export function useDocumentActions() {
  const session = useSession();
  const router = useRouter();
  const busy = useRef(false);
  return useMemo(() => {
    const recents = createRecentStore(session.replica.db, session.workspaceId);
    const current = () => {
      if (!session.isCurrent()) throw new Error("工作区会话已结束");
    };
    const read = (id: string) => {
      current();
      return readDocumentMenu(session.replica.db, id);
    };
    const requireDocument = (id: string) => {
      const doc = read(id);
      if (!doc) throw new Error("文档不存在，可能已被删除");
      return doc;
    };
    const run = async (job: () => void | Promise<void>) => {
      if (busy.current) return;
      busy.current = true;
      try {
        current();
        await job();
      } catch (error) {
        if (session.isCurrent())
          Alert.alert(
            "操作失败",
            error instanceof Error ? error.message : String(error),
          );
      } finally {
        busy.current = false;
      }
    };
    const removeRecent = (id: string) =>
      void run(() => recents.forget("document", id));
    const deleteDocument = (id: string) =>
      void run(() => {
        const doc = requireDocument(id);
        Alert.alert(
          "删除文档",
          `删除「${doc.title || "未命名"}」？仅删除此文档，子文档移到顶层。本地恢复草稿只在删除成功后清除。`,
          [
            { text: "取消", style: "cancel" },
            {
              text: "删除",
              style: "destructive",
              onPress: () =>
                void run(async () => {
                  await deleteListedDocument({
                    protect: () => freezeAndFlushEditors(session.replica),
                    isCurrent: session.isCurrent,
                    commit: () => {
                      requireDocument(id);
                      return session.client.deleteDocument(id);
                    },
                    discardDraft: () =>
                      session.replica.service.drafts.discardDocument(id),
                    forgetRecent: () => recents.forget("document", id),
                  });
                }),
            },
          ],
        );
      });
    const perform = (id: string, action: DocumentMenuAction) => {
      if (action === "delete") {
        deleteDocument(id);
        return;
      }
      void run(async () => {
        requireDocument(id);
        if (action === "copy-id") {
          await Clipboard.setStringAsync(id);
          if (!session.isCurrent()) return;
          AccessibilityInfo.announceForAccessibility("已复制 ID");
          if (Platform.OS === "android")
            ToastAndroid.show("已复制 ID", ToastAndroid.SHORT);
          else Alert.alert("已复制 ID");
        } else if (action === "move-root") {
          const release = await freezeAndFlushEditors(session.replica);
          try {
            current();
            if (requireDocument(id).parent_id)
              await session.client.updateDocument(id, { parent_id: null });
          } finally {
            release();
          }
        } else {
          router.push(
            `/manage/document/${encodeURIComponent(id)}?mode=${action}`,
          );
        }
      });
    };
    return { read, perform, deleteDocument, removeRecent };
  }, [session, router]);
}
export type DocumentActions = ReturnType<typeof useDocumentActions>;
