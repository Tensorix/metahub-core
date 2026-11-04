import { useCallback } from "react";
import * as WebBrowser from "expo-web-browser";
import { useSession } from "@/lib/auth/session";
import { useApiData, useLiveInvalidate } from "@/lib/api/hooks";
import { mobileSites, type MobileSite } from "./sites";
import { useRecents } from "./use-recents";
export function useSites() {
  const { replica, creds } = useSession();
  const { store } = useRecents();
  const fetcher = useCallback(
    async () =>
      mobileSites(replica.db, creds.bucket ? undefined : creds.baseUrl),
    [replica.db, creds.bucket, creds.baseUrl],
  );
  const state = useApiData(fetcher);
  useLiveInvalidate(["sites", "site_channels"], () => void state.refetch());
  const open = async (site: MobileSite) => {
    if (!site.url) return;
    // Mark only after the OS accepted the browser request, not while listing sites.
    await WebBrowser.openBrowserAsync(site.url);
    store.remember({ id: site.id, kind: "site", title: site.title });
  };
  return { ...state, open };
}
