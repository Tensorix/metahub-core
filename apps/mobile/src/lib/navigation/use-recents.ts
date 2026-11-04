import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/lib/auth/session";
import { createRecentStore } from "./recent";
export function useRecents() {
  const { replica, workspaceId } = useSession();
  const store = useMemo(
    () => createRecentStore(replica.db, workspaceId),
    [replica.db, workspaceId],
  );
  const [state, setState] = useState(() => ({ store, items: store.read() }));
  useEffect(
    () => store.subscribe(() => setState({ store, items: store.read() })),
    [store],
  );
  return { store, items: state.store === store ? state.items : store.read() };
}
