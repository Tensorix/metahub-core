import { useCallback, useEffect, useReducer } from "react";
import { useSession } from "@/lib/auth/session";
import type { DocumentActions } from "@/lib/browse/use-document-actions";
import { documentMenuItems } from "@/lib/browse/document-menu";

export function useDocumentMenu(id: string, actions: DocumentActions) {
  const session = useSession();
  const read = useCallback(() => {
    try {
      return actions.read(id);
    } catch {
      return null;
    }
  }, [actions, id]);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const document = read();
  useEffect(() => {
    return session.live.onChange((change) => {
      if (change.datasets.includes("documents")) refresh();
    });
  }, [session, refresh]);
  return {
    items: documentMenuItems(!!document?.parent_id),
    available: !!document,
    refresh,
  };
}
