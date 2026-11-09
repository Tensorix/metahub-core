import { useRouter } from "expo-router";
import { Platform } from "react-native";
import { useCallback, useSyncExternalStore } from "react";
import * as WebBrowser from "expo-web-browser";
import { useSession } from "@/lib/auth/session";
import { useApiData, useLiveInvalidate } from "@/lib/api/hooks";
import { mobileSites, type MobileSite } from "./sites";

export function useSites() {
  const { replica, creds, siteResources } = useSession();
  const router = useRouter();
  useSyncExternalStore(
    siteResources.subscribe,
    siteResources.snapshot,
    siteResources.snapshot,
  );
  const fetcher = useCallback(
    async () =>
      mobileSites(replica.db, creds.bucket ? undefined : creds.baseUrl),
    [replica.db, creds.bucket, creds.baseUrl],
  );
  const state = useApiData(fetcher);
  useLiveInvalidate(
    ["sites", "site_channels", "site_files"],
    () => void state.refetch(),
  );
  const open = async (site: MobileSite, from?: "home") => {
    if (Platform.OS === "web") {
      if (site.url) await WebBrowser.openBrowserAsync(site.url);
      else throw new Error("本机运行需要 iOS 或 Android");
      return;
    }
    router.push({ pathname: "/site/[id]", params: { id: site.id, from } });
  };
  return {
    ...state,
    open,
    missing: siteResources.missing,
    published: (site: MobileSite) =>
      site.url ? WebBrowser.openBrowserAsync(site.url) : undefined,
  };
}
