import { useMemo, useRef } from "react";
import { Alert, AccessibilityInfo, Platform, ToastAndroid } from "react-native";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useSession } from "../auth/session";
import { createRecentStore } from "../navigation/recent";
import { freezeAndFlushEditors } from "../editor/recovery-barrier";
import { deleteBrowseItem } from "./undo-delete";
import { undoStoreFor } from "./undo-store";
import type { LibraryKind } from "./library";
import {
  readDatabaseMenu,
  databaseMenuItems,
  documentMenuItems,
  readDocumentMenu,
  type DocumentMenuAction,
} from "./document-menu";

export function useDocumentActions(kind: LibraryKind = "documents") {
  const session = useSession();
  const router = useRouter();
  const busy = useRef(false);
  return useMemo(() => {
    const undoStore = undoStoreFor(session.replica);
    const database = kind === "databases";
    const recents = createRecentStore(session.replica.db, session.workspaceId);
    const current = () => {
      if (!session.isCurrent()) throw new Error("工作区会话已结束");
    };
    const read = (id: string) => {
      current();
      return database
        ? readDatabaseMenu(session.replica.db, id)
        : readDocumentMenu(session.replica.db, id);
    };
    const requireDocument = (id: string) => {
      const doc = read(id);
      if (!doc)
        throw new Error(
          database ? "数据库不存在，可能已被删除" : "文档不存在，可能已被删除",
        );
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
      void run(() => {
        const kind = database ? "database" : "document";
        const previous = recents
          .read()
          .find((item) => item.kind === kind && item.id === id);
        if (!previous) return;
        recents.forget(kind, id);
        undoStore.push(
          `已移出最近「${previous.title || "未命名"}」`,
          async () => {
            current();
            requireDocument(id);
            recents.restore(previous);
            return "已恢复最近记录";
          },
        );
      });
    const deleteDirect = (id: string) =>
      void run(async () => {
        const receipt = await deleteBrowseItem({
          service: session.replica.service,
          recents,
          kind: database ? "database" : "document",
          id,
          isCurrent: session.isCurrent,
          protect: () => freezeAndFlushEditors(session.replica),
        });
        undoStore.push(`已删除「${receipt.title}」`, receipt.undo);
      });
    const perform = (id: string, action: DocumentMenuAction) => {
      if (action === "delete") {
        deleteDirect(id);
        return;
      }
      void run(async () => {
        requireDocument(id);
        if (database && !["copy-id", "rename"].includes(action)) return;
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
            `/manage/${database ? "database" : "document"}/${encodeURIComponent(id)}?mode=${action}`,
          );
        }
      });
    };
    return {
      kind,
      read,
      perform,
      deleteDirect,
      removeRecent,
      menuItems: (hasParent: boolean) =>
        database ? databaseMenuItems() : documentMenuItems(hasParent),
    };
  }, [session, router, kind]);
}
export type DocumentActions = ReturnType<typeof useDocumentActions>;
