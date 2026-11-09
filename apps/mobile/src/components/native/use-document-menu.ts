import { useCallback, useEffect, useReducer } from "react";
import { useSession } from "@/lib/auth/session";
import type { DocumentActions } from "@/lib/browse/use-document-actions";

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
      if (change.datasets.includes(actions.kind)) refresh();
    });
  }, [session, actions.kind, refresh]);
  return {
    items: actions.menuItems(!!document?.parent_id),
    available: !!document,
    refresh,
  };
}
